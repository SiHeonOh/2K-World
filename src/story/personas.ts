import { rng, shuffle } from '@core/random'

/**
 * The community's cast, made by code from the league: fans spread over the
 * schools (bigger fan bases get more), a few neutral fans, and reporters at
 * made-up outlets. Same league + seed → same cast.
 */

export interface Archetype {
  id: string
  /** How the community would label them. */
  name: string
  /** One line for the writer: how this persona posts. */
  style: string
  spice: [number, number]
  /** Also gets 소문 lore (rumor-minded). */
  rumor: boolean
  /** Share of fans with this archetype. */
  weight: number
}

export const ARCHETYPES: Archetype[] = [
  { id: 'analyst', name: '분석러', style: '경기 내용을 차분하게 뜯어보고 근거를 댄다', spice: [1, 3], rumor: false, weight: 10 },
  { id: 'stats', name: '통계충', style: '숫자와 기록으로만 말한다, 표를 좋아한다', spice: [1, 3], rumor: false, weight: 8 },
  { id: 'troll', name: '어그로', style: '일부러 반대로 말해서 판을 키운다', spice: [3, 5], rumor: true, weight: 7 },
  { id: 'local', name: '지역부심', style: '자기 학교와 지역 자랑, 라이벌은 깎아내린다', spice: [2, 4], rumor: false, weight: 12 },
  { id: 'stan', name: '선수 빠', style: '좋아하는 선수 하나만 보고, 비판엔 발끈한다', spice: [2, 4], rumor: false, weight: 10 },
  { id: 'anti', name: '안티', style: '특정 팀이나 선수를 늘 깐다', spice: [3, 5], rumor: true, weight: 6 },
  { id: 'newbie', name: '뉴비', style: '규칙이나 선수를 물어보고, 말투가 공손하다', spice: [1, 2], rumor: false, weight: 8 },
  { id: 'memer', name: '밈장인', style: '짤과 드립, 유행어로 반응한다', spice: [2, 4], rumor: false, weight: 10 },
  { id: 'insider', name: '찌라시꾼', style: '"아는 형한테 들었는데"로 시작하는 소문을 푼다', spice: [2, 4], rumor: true, weight: 5 },
  { id: 'oldfan', name: '올드팬', style: '예전 시즌과 비교하며 "라떼는"을 말한다', spice: [1, 3], rumor: false, weight: 7 },
  { id: 'doomer', name: '비관론자', style: '이겨도 불안하고 지면 시즌 끝났다고 한다', spice: [2, 3], rumor: false, weight: 6 },
  { id: 'lurker', name: '눈팅족', style: '짧게 한마디만 남긴다', spice: [1, 2], rumor: false, weight: 6 },
]

/** The quirk of a fan who misremembers numbers on purpose: their posts and comments skip the number check. */
export const MISREMEMBERS = '숫자를 틀리게 기억한다'

export const QUIRKS = [
  '문장 끝에 ㅋㅋ를 붙인다',
  '초성체를 자주 쓴다',
  '맞춤법을 자주 틀린다',
  '항상 존댓말을 쓴다',
  '예측을 하고 맞으면 "내가 뭐랬냐"를 한다',
  '이모티콘 대신 ^^를 쓴다',
  '글을 짧게 끊어 쓴다',
  '느낌표를 많이 쓴다',
  '심판 탓을 자주 한다',
  '감독 전술 얘기를 꼭 한다',
  '"ㄹㅇ"과 "ㅇㅈ"을 자주 쓴다',
  MISREMEMBERS,
]

const NICK_HEADS = [
  '농구', '덩크', '삼점', '골밑', '벤치', '코트', '버저비터', '리바운드', '새벽', '직관', '응원석', '농잘알', '농알못', '자유투',
  '속공', '스텝백', '블락', '앨리웁', '풀코트', '원핸드', '노룩', '수비', '포스트', '하프라인', '샷클락', '트리플더블', '식스맨',
  '체육관', '매점', '야자', '방과후', '점심시간', '교복', '수학여행',
]
const NICK_TAILS = [
  '장인', '요정', '러버', '왕', '꾼', '고수', '중독', '덕후', '아재', '마스터', '지킴이', '빌런', '천재', '바보', '중독자', '인생',
  '박사', '전문가', '킹', '신', '맨', '보이', '소년', '단장', '감독', '해설', '찐팬',
]
const TEAM_TAILS = ['부심', '빠', '만세', '짱', '사랑', '지킴이', '응원단', '찐팬', '골수팬', '직관러']
const OUTLETS = ['코트일보', '하이스쿨후프', '림어택뉴스', '바스켓타임즈', '농구인사이드', '버저비터스포츠', '스쿨리그저널']
const REPORTER_SURNAMES = ['강', '고', '권', '남', '노', '도', '류', '문', '민', '배', '서', '설', '신', '엄', '여', '연', '염', '우', '원', '육', '은', '인', '제', '진', '채', '추', '탁', '피', '하', '함', '홍']
const REPORTER_GIVEN = ['기자', '특파원', '기자', '기자', '전문기자']

export interface PersonaSeed {
  id: string
  kind: 'fan' | 'reporter'
  nick: string
  teamId: string | null
  archetype: string
  spice: number
  quirks: string[]
  favPlayerId: string | null
  outlet: string | null
  level: number
  rumor: boolean
}

export interface CastInput {
  seed: string
  fans: number
  reporters: number
  maxSpice: number
  /** Fan base size per team (1-5, from team lore; 3 when unknown). */
  teams: { id: string; shortName: string; fanSize: number }[]
  players: { id: string; teamId: string; name: string }[]
}

/** Share of fans who back no school. */
const NEUTRAL_SHARE = 0.15

export function makeCast(input: CastInput): PersonaSeed[] {
  const random = rng(`cast:${input.seed}`)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1))
  const taken = new Set<string>(input.players.map((p) => p.name))
  const unique = (base: string) => {
    let nick = base
    while (taken.has(nick)) nick = `${base}${between(1, 999)}`
    taken.add(nick)
    return nick
  }
  const weighted = () => {
    const total = ARCHETYPES.reduce((s, a) => s + a.weight, 0)
    let roll = random() * total
    for (const a of ARCHETYPES) {
      roll -= a.weight
      if (roll < 0) return a
    }
    return ARCHETYPES[0]!
  }

  // Fans per team, proportional to fan base size; the rest neutral.
  const neutral = input.teams.length === 0 ? input.fans : Math.round(input.fans * NEUTRAL_SHARE)
  const backed = input.fans - neutral
  const weightSum = input.teams.reduce((s, t) => s + Math.max(1, t.fanSize), 0)
  const perTeam = input.teams.map((t) => ({ team: t, n: weightSum ? Math.floor((backed * Math.max(1, t.fanSize)) / weightSum) : 0 }))
  // Hand out the rounding remainder to the biggest fan bases first.
  let left = backed - perTeam.reduce((s, x) => s + x.n, 0)
  for (const x of [...perTeam].sort((a, b) => b.team.fanSize - a.team.fanSize)) {
    if (left <= 0) break
    x.n++
    left--
  }

  const cast: PersonaSeed[] = []
  const fan = (teamId: string | null, shortName: string | null) => {
    const a = weighted()
    const spice = Math.min(input.maxSpice, between(a.spice[0], a.spice[1]))
    const quirks = shuffle(QUIRKS, random).slice(0, between(0, 2))
    const roster = input.players.filter((p) => (teamId ? p.teamId === teamId : true))
    const fav = a.id === 'stan' && roster.length > 0 ? pick(roster) : null
    const nick =
      shortName && random() < 0.35
        ? `${shortName}${pick(TEAM_TAILS)}`
        : fav && random() < 0.5
          ? `${fav.name}${pick(['빠', '바라기', '팬', '최고'])}`
          : `${pick(NICK_HEADS)}${pick(NICK_TAILS)}`
    cast.push({
      id: `f${String(cast.filter((c) => c.kind === 'fan').length + 1).padStart(3, '0')}`,
      kind: 'fan',
      nick: unique(nick),
      teamId,
      archetype: a.id,
      spice: Math.max(1, spice),
      quirks,
      favPlayerId: fav?.id ?? null,
      outlet: null,
      // Most members are low level; a few veterans.
      level: Math.max(1, Math.round(30 * random() ** 2.2)),
      rumor: a.rumor,
    })
  }
  for (const { team, n } of perTeam) for (let i = 0; i < n; i++) fan(team.id, team.shortName)
  for (let i = 0; i < neutral; i++) fan(null, null)

  const outlets = shuffle(OUTLETS, random)
  for (let i = 0; i < input.reporters; i++) {
    const outlet = outlets[i % outlets.length]!
    cast.push({
      id: `r${String(i + 1).padStart(2, '0')}`,
      kind: 'reporter',
      nick: unique(`${outlet} ${pick(REPORTER_SURNAMES)}${pick(REPORTER_GIVEN)}`),
      teamId: null,
      archetype: 'reporter',
      spice: 1,
      quirks: [],
      favPlayerId: null,
      outlet,
      level: 30,
      rumor: false,
    })
  }
  return cast
}
