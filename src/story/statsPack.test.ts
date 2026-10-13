import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { currentSeason, seedLeague } from '@data/league'
import { addPlayedGame, closeSession } from '@data/played'
import { boxLines, listGames, recordScore, startSeason } from '@data/season'
import { ensureCast, gameThreadInput, readLeague, roundUpInput } from './context'
import { storyKinds } from './jobs'
import { readFacts, unknownNumbers } from './numbers'
import { gameEdges, headToHead, playerSeason, rankShift, readSeason, standingsRace, teamProfile } from './statsPack'

/**
 * The season's numbers worked out for the writers. Made-up schools: t1 가람고,
 * t2 나람고, t5 마람고, t6 바람고 in 동; t3 다람고, t4 라람고 in 서. 2K
 * 일정대로 here, so schools play unevenly: 가람고 four games, 다람고 one.
 */

let dir: string
let db: Db

type Stats = Record<string, number>
const line = (pts: number, reb: number, ast: number, fg: [number, number], tp: [number, number], ft: [number, number]): Stats => ({
  pts,
  reb,
  ast,
  fgm: fg[0],
  fga: fg[1],
  '3pm': tp[0],
  '3pa': tp[1],
  ftm: ft[0],
  fta: ft[1],
})

/** Plays a game in the open session; lines as [player, team, stats]. */
function play(home: string, away: string, homeScore: number, awayScore: number, lines: [string, string, Stats][] = []): number {
  const { gameId } = addPlayedGame(db, { home, away })
  recordScore(db, { gameId, homeScore, awayScore, lines: lines.length ? lines.map(([playerId, teamId, stats]) => ({ playerId, teamId, stats })) : null })
  return gameId
}

let g1: number
let g4: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-pack-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  setup.config.season.schedule = { kind: 'round-robin', cycles: 2, build: 'played' }
  seedLeague(db, setup)
  startSeason(db)
  // 1일차: 가람고 beats 나람고 at home (box lines), 라람고 wins at 다람고 (score only).
  g1 = play('t1', 't2', 80, 70, [
    ['p1', 't1', line(30, 5, 4, [11, 20], [4, 9], [4, 5])],
    ['p2', 't1', line(20, 8, 2, [8, 15], [2, 5], [2, 2])],
    ['p7', 't2', line(26, 10, 3, [10, 21], [2, 7], [4, 6])],
  ])
  play('t3', 't4', 60, 65)
  closeSession(db)
  // 2일차: 가람고 twice, both away.
  play('t2', 't1', 75, 77, [
    ['p1', 't1', line(25, 7, 6, [9, 18], [3, 8], [4, 4])],
    ['p2', 't1', line(18, 6, 3, [7, 14], [1, 4], [3, 4])],
  ])
  play('t5', 't1', 70, 90, [
    ['p1', 't1', line(34, 6, 5, [12, 22], [5, 10], [5, 6])],
    ['p2', 't1', line(22, 9, 1, [9, 16], [2, 6], [2, 2])],
  ])
  closeSession(db)
  // 3일차: 가람고 loses at home to 바람고, no box lines.
  g4 = play('t1', 't6', 68, 72)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('the stats pack', () => {
  it('profiles a school: record, places, points, shooting from its box lines, recent games, home and away, close games, extremes', () => {
    const profile = teamProfile(readSeason(readLeague(db, dir)), 't1')
    expect(profile[0]).toBe('[가람고] 4경기 3승 1패(승률 .750) · 동 2위 · 전체 3위')
    expect(profile).toEqual([
      profile[0],
      '- 경기당 득점 78.8점, 실점 71.8점, 득실 +7.0점',
      '- 야투 53.3%(56/105) · 3점슛 40.5%(17/42) · 자유투 87.0%(20/23) (박스스코어 있는 3경기 기준)',
      '- 경기당 리바 13.7 · 어시 7.0 · 턴오버 0.0',
      '- 경기 결과(최근 경기부터): 바람고전 68:72 패, 마람고전 90:70 승, 나람고전 77:75 승, 나람고전 80:70 승',
      '- 홈 1승 1패 · 원정 2승 0패',
      '- 5점 차 이내 접전 1승 1패',
      '- 최고의 승리 마람고전 90:70(20점 차) · 최악의 패배 바람고전 68:72(4점 차)',
    ])
    expect(profile.length).toBeLessThanOrEqual(10)
  })

  it('without box lines still gives the record and the scores', () => {
    const s = readSeason(readLeague(db, dir))
    expect(teamProfile(s, 't3')).toEqual([
      // Schools yet to play rank as .500, so 다람고 is last in 서 but not overall.
      '[다람고] 1경기 0승 1패(승률 .000) · 서 4위(1위와 1경기 차) · 전체 6위',
      '- 경기당 득점 60.0점, 실점 65.0점, 득실 -5.0점',
      '- 경기 결과(최근 경기부터): 라람고전 60:65 패',
      '- 홈 0승 1패 · 원정 0승 0패',
      '- 5점 차 이내 접전 0승 1패',
      '- 최악의 패배 라람고전 60:65(5점 차)',
    ])
    expect(playerSeason(s, 'p13')).toEqual(['[다가다] 이번 시즌 기록 없음'])
    // A school yet to play.
    expect(teamProfile(s, 't7')).toEqual(['[사람고] 이번 시즌 치른 경기 없음'])
  })

  it('gives a player’s season: averages with totals, shooting, best game, share of his team’s points, ranks', () => {
    const s = readSeason(readLeague(db, dir))
    expect(playerSeason(s, 'p1')).toEqual([
      '[가가가(가람고)] 3경기 평균 29.7점 6.0리바 5.0어시(총 89점 18리바 15어시)',
      '- 야투 53.3%(32/60) · 3점슛 44.4%(12/27) · 자유투 86.7%(13/15)',
      expect.stringMatching(/^- 시즌 최고 34점\(마람고전\) · 뛴 경기 팀 득점의 36\.0% · 리그 득점 1위, 리바운드 2위, 어시스트 1위/),
    ])
  })

  it('puts a player’s last five against his season once he has a game before them', () => {
    // Four more games for 가람고, 가가가 scoring 10 in each.
    for (const opp of ['t3', 't4', 't7', 't8']) {
      play('t1', opp, 70, 60, [['p1', 't1', line(10, 2, 2, [4, 10], [0, 2], [2, 2])]])
      closeSession(db)
    }
    const lines = playerSeason(readSeason(readLeague(db, dir)), 'p1')
    // Seven games: 129 points, 18.4 a game; the last five (34 and four 10s) 74 points, 14.8 a game.
    expect(lines[0]).toBe('[가가가(가람고)] 7경기 평균 18.4점 3.7리바 3.3어시(총 129점 26리바 23어시)')
    expect(lines[2]).toBe('- 최근 5경기 평균 14.8점 2.8리바 2.6어시(총 74점 14리바 13어시) · 득점은 시즌 평균보다 3.6점 적음')
  })

  it('works out meetings, what a session changed, the race, and where a game was decided', () => {
    const s = readSeason(readLeague(db, dir))
    expect(headToHead(s, 't1', 't2')).toBe('맞대결(이번 시즌): 가람고 기준 2승 0패 — 가람고 80:70 나람고, 나람고 75:77 가람고')
    expect(headToHead(s, 't1', 't3')).toBe('맞대결(이번 시즌): 가람고와 다람고는 아직 안 만났다')
    // 3일차: 바람고 (no games before) jumps 가람고; 라람고 is the new #1 on point margin.
    expect(rankShift(s, new Set([g4]))).toEqual(['- 전체 1위: 가람고 → 라람고', '- 동 순위 이동: 바람고 2위 → 1위, 가람고 1위 → 2위'])
    const race = standingsRace(s)
    expect(race.slice(0, 4)).toEqual(['## 동', '1. 바람고 1승 0패(1.000)', '2. 가람고 3승 1패(.750)', '── 여기까지 플레이오프 직행 ──'])
    expect(race).toContain('- 직행 경계: 2위 가람고 3승 1패 / 3위 나람고 0승 2패, 2경기 차')
    expect(race).toContain('## 서')
    const game = listGames(db, currentSeason(db).id).find((g) => g.id === g1)!
    expect(gameEdges(s, { ...game, homeScore: game.homeScore!, awayScore: game.awayScore! }, boxLines(db, g1))).toEqual([
      '- 야투 가람고 54.3%(19/35) 대 나람고 47.6%(10/21), 6.7%p 차',
      '- 3점슛 가람고 42.9%(6/14) 대 나람고 28.6%(2/7), 14.3%p 차, 3점으로 18점 대 6점',
      '- 자유투 가람고 85.7%(6/7) 대 나람고 66.7%(4/6), 19.0%p 차, 자유투로 6점 대 4점',
      '- 리바 가람고 13 대 나람고 10(3개 차)',
      '- 어시 가람고 6 대 나람고 3(3개 차)',
      '- 가장 크게 갈린 곳: 3점슛(가람고 우위)',
    ])
  })

  it('a writer quoting the pack, as numbers and the arithmetic on its lines, gets no unknown numbers', () => {
    const league = readLeague(db, dir)
    ensureCast(league)
    const missed = (facts: ReturnType<typeof readFacts>, sentences: string[]) => sentences.flatMap((t) => unknownNumbers(t, facts).map((n) => `${t} => ${n}`))
    const verbatim = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => /^(\[|- |맞대결|\d+\. )/.test(l))

    // An analysis topic's pack, as the chatter plan shows it (a line each, indented).
    const s = readSeason(league)
    const pack = [...teamProfile(s, 't1'), ...teamProfile(s, 't2'), headToHead(s, 't1', 't2'), ...playerSeason(s, 'p1'), ...standingsRace(s)]
    const plan = `# 이번에 쓸 글\n1. [분석 글 · 게시판 main · 길이 장문(분석글)] 장문 분석 글\n   자료: 주제: 가람고 vs 나람고\n${pack.map((l) => `   ${l}`).join('\n')}`
    const planFacts = readFacts(plan)
    const fromPack = [
      ...verbatim(plan),
      '가람고 4경기 3승 1패, 승률 .750으로 동 2위',
      '가람고 승률 75%, 전체 3위',
      '경기당 78.8점 넣고 71.8점 내줬다. 득실 +7.0점',
      '78.8점 넣고 71.8점 내주니 7.0점 앞선다',
      '야투 53.3%, 3점 40.5%, 자유투 87%',
      '야투 56/105, 리바운드 경기당 13.7개',
      '가가가 3경기 평균 29.7점 6.0리바 5.0어시, 총 89점',
      '가가가 시즌 최고 34점, 뛴 경기 팀 득점의 36%를 책임진다',
      '가가가 야투 32/60(53.3%), 3점 12/27(44.4%)',
      '마람고전 90:70, 20점 차 대승',
      '바람고전 68:72로 4점 차 패배',
      '5점 차 이내 접전은 1승 1패',
      '맞대결은 가람고가 2승 0패, 80:70에 77:75',
      '바람고 1승 0패로 1위, 가람고 2위',
      '3위 나람고와는 2경기 차',
    ]
    expect(fromPack.length).toBeGreaterThan(25)
    expect(missed(planFacts, fromPack)).toEqual([])

    // A game thread's blocks.
    const thread = gameThreadInput(league, g1, 0)
    const threadFacts = readFacts(thread.context, thread.instructions)
    const fromThread = [
      ...verbatim(thread.context),
      '오늘 가가가 30점, 팀 득점 80점의 37.5%',
      '야투율 54.3% 대 47.6%, 6.7%p 앞섰다',
      '3점으로만 18점 대 6점, 3점슛 성공률은 14.3%p 차이',
      '자유투 85.7%(6/7) 대 66.7%(4/6)',
      '리바 13 대 10, 3개 더 잡았다',
      '가람고는 4경기 3승 1패, 경기당 78.8점',
    ]
    expect(missed(threadFacts, fromThread)).toEqual([])
    // And a number neither holds is still caught.
    expect(unknownNumbers('가가가 야투율 61.9%', planFacts)).toEqual(['61.9%'])
    expect(unknownNumbers('가가가 오늘 야투율 61.9%', threadFacts)).toEqual(['61.9%'])
  })
})

describe('game threads and round-ups get the season', () => {
  it('in rounds: a game thread and the round-up carry the same blocks, named by round', () => {
    // A fresh league with rounds drawn up front: two rounds played, box lines for the first game of each.
    const roundDir = mkdtempSync(join(tmpdir(), '2kw-pack-rounds-'))
    const rdb = openDb(join(roundDir, 'league.db'))
    try {
      seedLeague(rdb, sampleSetup())
      startSeason(rdb)
      const season = currentSeason(rdb).id
      for (const round of [1, 2]) {
        listGames(rdb, season)
          .filter((g) => g.round === round)
          .forEach((g, i) => {
            const home = (rdb.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY id LIMIT 1').get(g.home) as { id: string }).id
            const lines = i === 0 ? [{ playerId: home, teamId: g.home, stats: line(21, 7, 5, [8, 15], [3, 6], [2, 3]) }] : null
            recordScore(rdb, { gameId: g.id, homeScore: 80 + i, awayScore: 70 + round, lines })
          })
      }
      const league = readLeague(rdb, roundDir)
      ensureCast(league)
      const first = listGames(rdb, season).find((g) => g.round === 2)!
      const thread = gameThreadInput(league, first.id, 0)
      expect(thread.context).toContain('# 두 학교 시즌 기록 (정규시즌, 이 경기 포함; 숫자는 여기 적힌 그대로)')
      expect(thread.context).toMatch(/\n\[\S+\] 2경기 \d승 \d패\(승률 /)
      expect(thread.context).toContain('# 오늘 활약과 시즌 기록\n- ')
      const up = roundUpInput(league, season, 2)!
      expect(up.instructions).toBe('R2 라운드 정리다.')
      expect(up.guide).toContain('말머리 라운드 정리')
      expect(up.context).toContain('# R2 활약 (시즌 기록과 함께)\n- ')
      expect(up.context).toContain('# 순위 경쟁 (R2까지; 숫자는 여기 적힌 그대로)\n## 동\n1. ')
      expect(up.context).toContain('# R2로 바뀐 것\n- ')
    } finally {
      rdb.close()
      rmSync(roundDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it('in 2K 일정대로: a game thread has both schools, the night’s players against their seasons, and the decisive numbers', () => {
    const league = readLeague(db, dir)
    ensureCast(league)
    const input = gameThreadInput(league, g1, 0)
    expect(input.context).toContain('# 두 학교 시즌 기록 (정규시즌, 이 경기 포함; 숫자는 여기 적힌 그대로)\n[가람고] 4경기 3승 1패')
    expect(input.context).toContain('\n[나람고] ')
    expect(input.context).toContain('맞대결(이번 시즌): 가람고 기준 2승 0패')
    expect(input.context).toContain('이 경기로 바뀐 순위:')
    expect(input.context).toContain('# 오늘 활약과 시즌 기록\n- 가가가(가람고) 오늘 30점 · 이번 시즌 첫 경기 · 오늘 팀 득점 80점의 37.5%')
    expect(input.context).toContain('# 승부를 가른 숫자 (이긴 쪽 먼저)\n- 야투 가람고 54.3%(19/35)')
    // A later game: his night against the games before it.
    const later = gameThreadInput(league, listGames(db, currentSeason(db).id).find((g) => g.home === 't5')!.id, 0)
    expect(later.context).toContain('- 가가가(가람고) 오늘 34점 · 이 경기 전 2경기 평균 27.5점 6.0리바 5.0어시(총 55점 12리바 10어시) · 평균보다 6.5점 많음 · 시즌 최고 경신(종전 30점)')
    // No box score: the schools' seasons, nothing about players or shooting.
    const plain = gameThreadInput(league, g4, 0)
    expect(plain.context).toContain('# 두 학교 시즌 기록')
    expect(plain.context).not.toContain('# 오늘 활약과 시즌 기록')
    expect(plain.context).not.toContain('# 승부를 가른 숫자')
    for (const text of [input.context, later.context, plain.context]) expect(text).not.toMatch(/\bR\d+\b|\d+라운드/)
  })

  it('in 2K 일정대로: the session’s round-up is a column with the race, the form and what the session changed', () => {
    const league = readLeague(db, dir)
    ensureCast(league)
    const input = roundUpInput(league, currentSeason(db).id, 2)!
    expect(input.instructions).toBe('2일차 정리다.')
    expect(input.guide).toContain('2일차 정리 칼럼')
    expect(input.guide).toContain('말머리 일차 정리')
    expect(input.context).toContain('# 2일차 활약 (시즌 기록과 함께)\n- 가가가 (가람고) 34점')
    expect(input.context).toMatch(/- 가가가 \(가람고\) 34점[^\n]* · 시즌 4경기|- 가가가 \(가람고\) 34점[^\n]* · 시즌 3경기 평균 29\.7점/)
    expect(input.context).toContain('# 순위 경쟁 (2일차까지; 숫자는 여기 적힌 그대로)\n## 동')
    expect(input.context).toContain('# 2일차로 바뀐 것\n')
    // The guide is prompt, not facts: its numbers aren't the writer's to quote.
    const prompt = storyKinds(db)
      .find((k) => k.kind === 'event_thread')!
      .prompt(input)
    expect(prompt).toContain(`${input.guide}\n\n2일차 정리다.`)
    expect(unknownNumbers('1500점', readFacts(input.context, input.instructions))).toEqual(['1500점'])
    for (const text of [input.instructions, input.context, input.guide!]) {
      expect(text).not.toMatch(/\bR\d+\b|\d+라운드/)
      expect(text).not.toContain('라운드 정리')
    }
  })
})
