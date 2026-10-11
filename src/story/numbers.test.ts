import { describe, expect, it } from 'vitest'
import { numberTokens, parseFlag, splitMarked, tagUnverified, untag, UNVERIFIED, usesNumber } from '@shared/numbers'
import { alsoKnown, alsoUnverified, checkNumbers, numberGate, NumbersRedo, readFacts, retryNote, unknownNumbers, withRetryNote } from './numbers'

const raw = (text: string) => numberTokens(text).map((t) => t.raw)
const unknown = (text: string, ...facts: string[]) => unknownNumbers(text, readFacts(...facts))

describe('numberTokens', () => {
  it('reads numbers glued to Korean, scores as two numbers, decimals, percentages and thousands', () => {
    expect(raw('가람고 3연승, 31득점으로 2위')).toEqual(['3', '31', '2'])
    expect(raw('155:115 대승, 98-85')).toEqual(['155', '115', '98', '85'])
    expect(raw('평균 22.0점 43.5분')).toEqual(['22.0'])
    expect(numberTokens('야투율 49% · 3할')).toMatchObject([{ raw: '49', value: 49, percent: true, unit: '%' }, { raw: '3', percent: false }])
    expect(numberTokens('통산 1,234점')).toMatchObject([{ raw: '1,234', value: 1234, decimals: 0, unit: '점' }])
    expect(numberTokens('34.5')).toMatchObject([{ value: 34.5, decimals: 1, unit: '' }])
  })

  it('keeps the unit glued to a number, so 41점 and 41위 are told apart', () => {
    expect(numberTokens('31점이었음, 9리바, 3연승, 2위, 45.5 %, 23번').map((t) => `${t.raw}|${t.unit}`)).toEqual(['31|점', '9|리바', '3|연승', '2|위', '45.5|%', '23|번'])
    expect(numberTokens('45퍼센트').map((t) => [t.unit, t.stop])).toEqual([['%', 5]])
  })

  it('reads percentage points as a gap, not a share, and a win rate with no leading zero', () => {
    expect(numberTokens('32.3%p, 6.7 %p, 5퍼센트포인트, 4%포인트').map((t) => `${t.raw}|${t.unit}|${t.percent}`)).toEqual(['32.3|%p|false', '6.7|%p|false', '5|%p|false', '4|%p|false'])
    expect(numberTokens('승률 .750, 0.750, 3.750').map((t) => [t.raw, t.value, t.decimals])).toEqual([
      ['.750', 0.75, 3],
      ['0.750', 0.75, 3],
      ['3.750', 3.75, 3],
    ])
  })

  it('skips replies, the game, ids, years, dates and times, school years and basketball idioms', () => {
    expect(raw('#3 동의합니다. #12 반대')).toEqual([])
    expect(raw('NBA 2K26 하다가 2K 리그 봄')).toEqual([])
    expect(raw('r12에서 고쳤다, f109님 말이 맞음')).toEqual([])
    expect(raw('2026년 시즌, 2025 시즌, 2026-27 시즌, 2026 정규시즌')).toEqual([])
    expect(raw('3월 15일 오후 10시에, 5초 남기고, 2시간 동안')).toEqual([])
    expect(raw('고3 에이스, 18살, 18세, 1학년')).toEqual([])
    expect(raw('3점슛 성공, 3점 라인, 4쿼터 역전, 3대3, 3P%')).toEqual([])
    expect(raw('이건 100% 우승이다, 1000% 확신함')).toEqual([])
    expect(raw('30점대 득점, 20점 넘게, 40점 가까이, 10개 이상')).toEqual([])
    // Only round numbers: 31점 넘게 is a claim about 31. And 80대 77 is a score.
    expect(raw('31점 넘게, 80대 77')).toEqual(['31', '80', '77'])
    expect(raw('{{{+1 크게}}} {{{#ff0000 빨강}}}')).toEqual([])
    // A season (시즌) and a share of a whole (3분의 1) are numbers.
    expect(raw('3시즌 연속, 3분의 1')).toEqual(['3', '3', '1'])
  })

  it('reads a year only as a year: 통산 2010점 is a number', () => {
    expect(raw('통산 2010점, 2026 시즌')).toEqual(['2010'])
    expect(raw('2026-10-03 경기, 2026.10.3에')).toEqual([])
  })

  it('reads minutes on court as a stat, and clock time as time', () => {
    expect(raw('30분 출전, 30분 뛰고, 25분간 소화, 40분 풀타임')).toEqual(['30', '30', '25', '40'])
    expect(raw('5분 남기고, 경기 시작 10분 만에')).toEqual([])
  })

  it('skips heights, weights, views, 50-50 balls, positions, zones, times and dates', () => {
    expect(raw('190cm 센터, 195센치, 80kg, 85키로')).toEqual([])
    expect(raw('조회수 1,234 실화냐, 조회 532')).toEqual([])
    expect(raw('50-50 볼 다 뺏김, 50:50 싸움')).toEqual([])
    expect(raw('3번(스몰포워드), 4번 포지션, 2번 가드, 5번 자리, 3번, 4번 다 봄')).toEqual([])
    expect(raw('2-3 지역방어, 3-2 존, 1-3-1 드롭존, 2:3 수비')).toEqual([])
    expect(raw('19:30 경기, 오후 7:30에')).toEqual([])
    expect(raw('10/3 경기, 10.3 일정, 10/3(토), 토요일 10/3')).toEqual([])
    // "Whether by one or a hundred": either way, not a claim (seen with real Claude).
    expect(raw('1점차든 100점차든 이긴 건 상산고임, 30점이든지 뭐든')).toEqual([])
    // A claim next to it still counts.
    expect(raw('1점차든 뭐든 31점 넣었다')).toEqual(['31'])
  })

  it('still reads a shirt number, a count of times, a score and an average that look alike', () => {
    expect(raw('등번호 23번, 5번 이겼다, 3번째')).toEqual(['23', '5', '3'])
    expect(raw('78:65 경기, 3-2로 끝난 시리즈, 평균 10.3점, 야투 7/15')).toEqual(['78', '65', '3', '2', '10.3', '7', '15'])
    expect(raw('2:3 트레이드')).toEqual(['2', '3'])
  })
})

describe('unknownNumbers', () => {
  const facts = [
    '# 이 경기',
    'R3 · 가람고 98 : 85 누리고',
    '가람고: 가가가 31점 9리바 4어시 (야투 12/20, 3점 3/7) / 가나나 22점 5리바 2어시 (야투 8/15, 3점 2/4)',
    '# 순위',
    '1. 가람고 5승 3패 (W3)',
    '- 가가가: 2경기 69점 · 시즌 최고 41점',
    '- 나나다: 3경기 평균 25.3점',
  ].join('\n')

  it('knows numbers the facts hold, rounded to the precision written', () => {
    expect(unknown('가가가 31점 9리바, 가람고 98:85 승리, 3연승', facts)).toEqual([])
    expect(unknown('나나다 평균 25점, 평균 25.3점', facts)).toEqual([])
    expect(unknown('가가가 31.0점', facts)).toEqual([])
    // Rounded, not cut: 25.3 is 25, not 26; and a made-up digit isn't 25.3.
    expect(unknown('평균 26점', facts)).toEqual(['26점'])
    expect(unknown('평균 25.35점', facts)).toEqual(['25.35점'])
  })

  it('knows sums and differences of numbers that belong together in a line of the facts', () => {
    // The margin (98 − 85), the total (183) and games played (5 + 3).
    expect(unknown('13점 차 승리, 183점 난타전, 8경기 치름', facts)).toEqual([])
    // Two players' points on one line (31 + 22), and the misses of a made/attempted line (20 − 12).
    expect(unknown('둘이 53점 합작, 9점 차이, 야투 8개 놓침', facts)).toEqual([])
    // Threes made are points too: 3점 2/4 is 6점.
    expect(unknown('가나나는 3점으로만 6점', facts)).toEqual([])
    // Bare numbers under one label: the two sides' rebounds and field goals made, apart.
    const totals = '팀 합계: 가람고 야투 30/66, 리바 40, 어시 19 / 나람고 야투 28/70, 리바 35, 어시 15'
    expect(unknown('리바운드 5개 차이, 야투 2개 더 넣고 4개 덜 던짐', totals)).toEqual([])
  })

  it('doesn’t add up numbers of different kinds, or bare numbers that merely sit together', () => {
    // 31점 4어시 makes neither 35 nor 27; made and attempted (12/20) don't add up to 32.
    expect(unknown('35점, 27점, 32개', facts)).toEqual(['35점', '27점', '32개'])
    // Places and streaks don't add up either.
    expect(unknown('6위', '1위 가람고 · 2위 나람고 · 4위 다람고 · 3연승 · 3연승')).toEqual(['6위'])
  })

  it('knows shares only from made/attempted and records, as written there', () => {
    // 12/20 and 76/155: shooting percentages.
    expect(unknown('야투율 60%, 야투율 0.6', facts)).toEqual([])
    expect(unknown('약 49%의 야투율', '- 가람고 야투 76/155')).toEqual([])
    // 5승 3패: a win rate of 5 of 8.
    expect(unknown('승률 0.625, 승률 62.5%', facts)).toEqual([])
    // Not the other way round (20/12), not points over games (69/2), not two numbers that merely sit together.
    expect(unknown('1.67', facts)).toEqual(['1.67'])
    expect(unknown('평균 34.5점', facts)).toEqual(['34.5점'])
    expect(unknown('리바 비율 69.2%', '가가가 9리바 4어시')).toEqual(['69.2%'])
    // Nothing made, nothing to share: 야투 0/0 makes no percentage.
    expect(unknown('야투율 45%', '가가가 0점 (야투 0/0, 3점 0/0)')).toEqual(['45%'])
    // A win rate with no leading zero; games played out of a schedule (16/28경기); a series won 4-2.
    expect(unknown('승률 .625', facts)).toEqual([])
    expect(unknown('승률 .700', facts)).toEqual(['.700'])
    expect(unknown('시즌 57% 지났다, 12경기 남음', '정규시즌 16/28경기 진행')).toEqual([])
    expect(unknown('시리즈 승률 66.7%', '- 1라운드: 가람고가 나람고를 4-2로 꺾음')).toEqual([])
    expect(unknown('승률 50.6%', 'R1 가람고 81-77 나람고')).toEqual(['50.6%'])
  })

  it('knows percentage points as the gap between two shares on a line', () => {
    const totals = '팀 합계: 가람고 야투 33/100, 3점 9/32 / 마람고 야투 49/75, 3점 15/30'
    // 65.3% − 33% (each side's field goals), however it was rounded before taking them apart.
    expect(unknown('야투율에서 32.3%p 앞섰다, 32.4%p 차이', totals)).toEqual([])
    expect(unknown('1위와 6.7퍼센트포인트 차이', '자료: 1. 가가가 45.5% · 4경기 / 2. 나나나 38.8% · 4경기')).toEqual([])
    expect(unknown('야투율에서 12.5%p 앞섰다', totals)).toEqual(['12.5%p'])
  })

  it('knows a gap, a sum or a share of two known numbers in one sentence of the text, nothing else', () => {
    // A season high and tonight's points sit on different lines: the gap counts once a sentence names both.
    const apart = ['- 가가가 시즌 최고 41점', '- 오늘 가가가 31점 9리바', '- 가람고 124점'].join('\n')
    expect(unknown('최고 41점, 오늘 31점, 10점 모자랐다', apart)).toEqual([])
    expect(unknown('최고 41점, 오늘 31점, 합치면 72점', apart)).toEqual([])
    expect(unknown('가가가 31점, 팀 124점 중 25%', apart)).toEqual([])
    expect(unknown('10점 모자랐다', apart)).toEqual(['10점'])
    // Not across sentences, not counts of two kinds (31점 9리바), and not from a number the facts don't hold.
    expect(unknown('최고 41점. 오늘 31점. 10점 모자랐다', apart)).toEqual(['10점'])
    expect(unknown('오늘 31점 9리바, 합쳐서 40', apart)).toEqual(['40'])
    expect(unknown('55점, 31점, 24점 차', apart)).toEqual(['55점', '24점'])
    // Two shares apart, in percentage points.
    expect(unknown('야투율 45.5% vs 40%, 5.5%p 차이', '- 가람고 야투 45.5%', '- 나람고 야투 40%')).toEqual([])
  })

  it('flags numbers that are neither in the facts nor worked out from them, each once, as written with their unit', () => {
    expect(unknown('가가가 47점 폭발! 47점은 커리어 하이, 야투 72.5%', facts)).toEqual(['47점', '72.5%'])
    // Numbers far apart in the facts don't make a sum together.
    expect(unknown('합쳐서 130점', ['가람고 98점', '누리고 32점'].join('\n'))).toEqual(['130점'])
    // A past-tense claim, whatever words it uses.
    expect(unknown('예상대로 37점 넣었다', facts)).toEqual(['37점'])
    expect(unknown('어제 37점 넣었는데 다음엔 40점 넣겠지', facts)).toEqual(['37점'])
    expect(unknown('37점 넣었으면 뭐하냐 졌는데', facts)).toEqual(['37점'])
    expect(unknown('다음 경기 앞두고 37점 넣은 가가가', facts)).toEqual(['37점'])
    expect(unknown('37점 넣은 가가가 덕에 다음에도 이기겠지', facts)).toEqual(['37점'])
    expect(unknown('38분 뛰고 31점이면 효율 좋네', facts)).toEqual(['38분'])
    expect(unknown('오늘 야투율 45%였음', facts)).toEqual(['45%'])
    // Saying you'll write it down is no forecast: what's written is a claim.
    expect(unknown('통산 4321득점 학교라고 덧붙이겠습니다', facts)).toEqual(['4321득점'])
    expect(unknown('4321득점으로 고치겠습니다', facts)).toEqual(['4321득점'])
  })

  it("doesn't check predictions, conditions and hypotheticals", () => {
    expect(unknown('다음 경기는 30점 차로 이긴다', facts)).toEqual([])
    expect(unknown('가가가 40점 넣으면 인정', facts)).toEqual([])
    expect(unknown('이 페이스면 16강은 간다', facts)).toEqual([])
    expect(unknown('가가가 시즌 평균 27.5점 찍겠네', facts)).toEqual([])
    expect(unknown('7전 4선승제였으면 몰랐다', facts)).toEqual([])
    expect(unknown('40점 넣었으면 좋았을 텐데', facts)).toEqual([])
    expect(unknown('다음엔 40점 넣을 듯, 50점 넣을걸ㅋㅋ', facts)).toEqual([])
    expect(unknown('가람고 시즌 25승 예상', facts)).toEqual([])
    expect(unknown('가람고 70점 넘긴다면 무조건 이김', facts)).toEqual([])
    expect(unknown('이번 시즌 목표는 평균 30점', facts)).toEqual([])
    expect(unknown('내일 40점 가즈아', facts)).toEqual([])
    expect(unknown('16강 가면 인정, 30점 차로 지면 은퇴', facts)).toEqual([])
    // A noun that ends in 면 is no condition: "그 장면" after a number is a claim.
    expect(unknown('38점 넣은 그 장면', facts)).toEqual(['38점'])
    expect(unknown('다음 시즌엔 평균 33점 넣겠습니다', facts)).toEqual([])
    expect(unknown('가가가 33점 넣을 거라고 봄', facts)).toEqual([])
    // 다음 covers what follows it (it's no sentence ending like 넣음); orders, needs, wishes and calls look ahead too.
    expect(unknown('다음 경기엔 57점 넣어라', facts)).toEqual([])
    expect(unknown('57점 넣어야지, 최소 47점은 넣어야 함, 47점은 넣었어야지', facts)).toEqual([])
    expect(unknown('57점 넣고 싶다. 57점 넣고 싶었는데. 가가가 57점 넣어줬으면', facts)).toEqual([])
    expect(unknown('57점은 넣을 줄 알았다. 47점 찍을 기세였음. 47점 넣을 수도 있었는데', facts)).toEqual([])
    expect(unknown('나람고 23승 각이다. 우승 확률 80%. 23승 5패로 끝내자', facts)).toEqual([])
    // A condition's consequence is hypothetical too, and so is what a forecast leads into.
    expect(unknown('나람고 이대로 가면 23승. 내가 박제한다, 나람고 23승', facts)).toEqual([])
    expect(unknown('마람고 @ 라람고: 라람고 95:88 승', facts)).toEqual([])
  })

  it('checks claims that only sound like a prediction', () => {
    // "As expected" tells what happened; a stat is a claim even next to 내일; "이번엔" is no forecast.
    expect(unknown('예상대로 가가가 57점 폭발', facts)).toEqual(['57점'])
    expect(unknown('내일 경기 앞두고 가가가 시즌 평균 57점', facts)).toEqual(['57점'])
    expect(unknown('이번엔 57점 차 대승', facts)).toEqual(['57점'])
    // A condition that's a jab, not a hypothetical.
    expect(unknown('57점 넣으면 뭐하냐 졌는데', facts)).toEqual(['57점'])
    expect(unknown('47점 넣으면 뭐함', facts)).toEqual(['47점'])
    // What came after something isn't ahead; past words and past tense win.
    expect(unknown('개막전 다음 경기에서 47점 넣음. 그 다음 쿼터에 57점', facts)).toEqual(['47점', '57점'])
    expect(unknown('다음 상대 나람고는 지난 경기 47점 차 대패', facts)).toEqual(['47점'])
    expect(unknown('57점 넣을 줄은 몰랐다', facts)).toEqual(['57점'])
  })

  it("doesn't check 0, 1 and 2", () => {
    expect(unknown('2경기 연속, 1위, 0점', '')).toEqual([])
    expect(unknown('3경기', '')).toEqual(['3경기'])
  })

  it('reads the cast as who may write, not as facts', () => {
    const context = [
      '# 이 경기',
      'R1 · 가람고 81 : 77 나람고',
      '# 쓸 수 있는 사람 (author에는 id를 그대로)',
      'f109 · 닉: 응원석찐팬 · 가람고 팬 · 비관론자 · 매운맛 3/5 · 기억: 「가람고 44점 차 승 예상」',
      'f187 · 닉: 아람고골수팬903 · 중립 · 매운맛 2/5',
      'r03 · 김기자 · 기자 (농구일보) · 기사체',
      '# 이미 나온 이야기 (같은 제목 금지)',
      '- 「가람고 81:77 승리」',
    ].join('\n')
    expect(unknownNumbers('109점, 187득점, 903명, 60%, 40%, 44점 차, 81점', readFacts(context))).toEqual(['109점', '187득점', '903명', '60%', '40%', '44점'])
  })

  it('reads nicknames, 속마음, 기억 and text nothing checked as not facts', () => {
    const context = [
      '#3 아람고골수팬903(f187): 가람고가 이긴다',
      '[12] 「바람돌이777」: 「ㅋㅋ」',
      '- 트레이드 뒤 인터뷰 「여기서 뛰는 게 좋아요」 · 속마음 「41점 넣고 싶다」',
      // A 토론's topic and status lines (a close note), why an editor objects, a poll's question and options.
      '# 토론 「통산 61점 관련」 (문단 「개요」)',
      '(「토론을 닫음: 62점으로 합의」)',
      'f012가 반대한다: 「63점은 과장」 (갈린 정도 3/5)',
      '투표: 「64점 넘길까?」 보기: 1번 「65점」 / 2번 「66점」',
      '- 「가가가 31점」',
    ].join('\n')
    expect(unknownNumbers('903명, 777, 41점, 61점, 62점, 63점, 64점, 65점, 66점, 31점', readFacts(context))).toEqual([
      '903명',
      '777',
      '41점',
      '61점',
      '62점',
      '63점',
      '64점',
      '65점',
      '66점',
    ])
  })

  it('counts a number shown as unverified as known, and marks it where a text repeats it', () => {
    const context = [
      '- 「가가가 41점(확인 안 된 숫자) 넣었다」',
      '- 「야투율 45 %(확인 안 된 숫자)」, 「88 퍼센트(확인 안 된 숫자)」, 「통산 4321득점(확인 안 된 숫자)」',
      '- 「가가가 31점」',
    ].join('\n')
    const facts = readFacts(context)
    // Quoting or disputing it isn't the writer's invention (no retry), but the repeat is marked, written any way.
    expect(checkNumbers('41점은 과장이고 31점이 맞다', facts)).toEqual({ unknown: [], unverified: ['41점'] })
    expect(checkNumbers('41득점? 41 넣었다는 건 오보, 45%도, 88%도, 4321점도', facts)).toEqual({ unknown: [], unverified: ['41득점', '41', '45%', '88%', '4321점'] })
    // Not a fact: no arithmetic with it in the facts, and a number the facts hold isn't marked.
    expect(checkNumbers('72점, 31점', facts)).toEqual({ unknown: ['72점'], unverified: [] })
  })

  it('counts numbers handed in as known: marked words being quoted, a fuzzy fan being corrected', () => {
    const facts = readFacts('# 이 경기\nR1 · 가람고 81 : 77 나람고\n가람고: 가가가 31점 9리바 4어시')
    expect(unknownNumbers('55점은 무슨ㅋㅋ 31점이었음', facts)).toEqual(['55점'])
    expect(unknownNumbers('55점은 무슨ㅋㅋ 31점이었음', alsoKnown(facts, [55]))).toEqual([])
    // His marked 41점: quoting it isn't redone, and it's marked whatever unit it's written with.
    const words = alsoUnverified(facts, ['41점'])
    expect(checkNumbers('41점 경기가 제일 기억나, 41득점, 41리바', words)).toEqual({ unknown: [], unverified: ['41점', '41득점', '41리바'] })
    // A number the facts hold isn't his: 31점 stays unmarked even if he'd said it too.
    expect(checkNumbers('31점', alsoUnverified(facts, ['31점']))).toEqual({ unknown: [], unverified: [] })
  })

  it('stays bounded on huge facts', () => {
    const big = readFacts(Array.from({ length: 50_000 }, (_, i) => String(i + 3)).join(' '))
    expect(big.sums.length).toBeLessThanOrEqual(40_000)
    expect(unknownNumbers('99999점', big)).toEqual(['99999점'])
  })
})

describe('the retry and its gate', () => {
  it('names the numbers in a note appended to the instructions; with none, it only reminds the rule', () => {
    expect(retryNote(['41점', '72%'])).toBe('지난번 글에 자료에 없는 숫자가 있었다: 41점, 72%. 숫자는 자료에 있는 것만 쓰고, 계산한 숫자는 자료의 숫자로 바로 계산되는 것만 쓴다.')
    expect(withRetryNote('쓴다.', undefined)).toBe('쓴다.')
    expect(withRetryNote('쓴다.', ['41점'])).toBe(`쓴다.\n\n${retryNote(['41점'])}`)
    expect(withRetryNote('쓴다.', [])).toBe('쓴다.\n\n숫자는 자료에 있는 것만 쓰고, 계산한 숫자는 자료의 숫자로 바로 계산되는 것만 쓴다.')
  })

  it('gathers what a job wrote, and asks for a redo only when it may still have one', () => {
    const gate = numberGate(readFacts('가가가 31점'), false)
    expect(gate.check('31점')).toEqual([])
    expect(gate.check('41점, 72점')).toEqual(['41점', '72점'])
    expect(gate.check('다시 41점')).toEqual(['41점'])
    expect(gate.unknown).toEqual(['41점', '72점'])
    expect(() => gate.redoIfAny()).toThrow(NumbersRedo)
    const last = numberGate(readFacts(''), true)
    last.check('41점')
    expect(() => last.redoIfAny()).not.toThrow()
  })
})

describe('marking numbers on screen', () => {
  it('marks a bare number (rows from before units) wherever the check read it, and nothing it skipped', () => {
    expect(splitMarked('가가가 41점, #41 참고, 41.0', ['41'])).toEqual([
      { text: '가가가 ', marked: false },
      { text: '41', marked: true },
      { text: '점, #41 참고, ', marked: false },
      { text: '41.0', marked: true },
    ])
    expect(splitMarked('아무 숫자 없음', [])).toEqual([{ text: '아무 숫자 없음', marked: false }])
    expect(usesNumber('평균 22.0점', '22')).toBe(true)
    expect(usesNumber('2026년', '2026')).toBe(false)
  })

  it('marks a number with its unit only where it has that unit, and only the digits', () => {
    expect(splitMarked('3쿼터 3점 31점 3번', ['3번'])).toEqual([
      { text: '3쿼터 3점 31점 ', marked: false },
      { text: '3', marked: true },
      { text: '번', marked: false },
    ])
    expect(splitMarked('78-65, 65점', ['65점'])).toEqual([
      { text: '78-65, ', marked: false },
      { text: '65', marked: true },
      { text: '점', marked: false },
    ])
    expect(splitMarked('45.5%, 45.5퍼센트, 45.5점', ['45.5%']).filter((p) => p.marked)).toHaveLength(2)
    expect(usesNumber('41위', '41점')).toBe(false)
    expect(usesNumber('41.0점이었다', '41점')).toBe(true)
    expect(parseFlag('1,234점')).toEqual({ value: 1234, unit: '점' })
    expect(parseFlag('45퍼센트')).toEqual({ value: 45, unit: '%' })
    expect(parseFlag('없음')).toBeNull()
  })

  it('shows marked numbers to writers as unverified, and drops the tag from what they write', () => {
    expect(tagUnverified('가가가 41점이었고 41위', ['41점'])).toBe(`가가가 41점${UNVERIFIED}이었고 41위`)
    expect(tagUnverified('78-65', ['65'])).toBe(`78-65${UNVERIFIED}`)
    expect(tagUnverified('야투율 45 %', ['45%'])).toBe(`야투율 45 %${UNVERIFIED}`)
    expect(tagUnverified('그대로', [])).toBe('그대로')
    expect(untag(`가가가 41점${UNVERIFIED} 넣었다`)).toBe('가가가 41점 넣었다')
    // However it was copied.
    expect(untag('41점 (확인 안된 숫자), 42점(확인안된 숫자)은, 43점[확인 안 된 숫자] 넣었다')).toBe('41점, 42점은, 43점 넣었다')
  })

  it('takes 득점 for 점 (and the like) when matching a mark', () => {
    expect(usesNumber('가가가 41득점 경기', '41점')).toBe(true)
    expect(usesNumber('41리바운드', '41리바')).toBe(true)
    expect(usesNumber('41위', '41점')).toBe(false)
    expect(parseFlag('32.3%p')).toEqual({ value: 32.3, unit: '%p' })
    expect(parseFlag('.750')).toEqual({ value: 0.75, unit: '' })
  })
})
