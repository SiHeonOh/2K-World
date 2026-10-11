import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { lastEventId, lastNewsEventId, setStoryValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { currentSeason, seedLeague } from '@data/league'
import { boxLines, getGame, listGames, playoffsView, recordScore, standings, startPlayoffs, startSeason } from '@data/season'
import { chatterInput, gameThreadInput, readLeague, short } from '@story/context'
import { readFacts, unknownNumbers, type Facts } from '@story/numbers'
import { storyDemo, storyKinds } from '@story/jobs'
import { roundWikiInput, WIKI_EDITS, wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { AiService } from './ai'
import { StoryService } from './story'
import { WikiService } from './wiki'

/**
 * The number check against honest writing and made-up claims. A false alarm
 * costs a whole real Claude call (a story batch is redone whole), so every
 * honest sentence here, built from a fixture league's real facts the way a
 * writer would put them, must pass; then the made-up claims must be caught.
 */

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-honest-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  await ai.refresh()
  story = new StoryService(ai)
  startSeason(db)
  new WikiService({}).ensure(db, dir, true)
  story.afterChange('test', db, dir)
  await ai.queueFor('test', db, dir).kick()
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type Line = { playerId: string; teamId: string; stats: Record<string, number> }

/** A repeatable random number source. */
function random(seed0: number) {
  let seed = seed0
  return (k: number) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k)
  }
}

/** Box lines for every player of two schools, adding up to the score. */
function boxScore(home: string, away: string, rnd: (k: number) => number): { lines: Line[]; home: number; away: number } {
  const roster = (team: string) => (db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY id').all(team) as { id: string }[]).map((p) => p.id)
  const line = (playerId: string, teamId: string): Line => {
    const fga = 8 + rnd(14)
    const fgm = Math.min(fga, 3 + rnd(9))
    const pa = 2 + rnd(7)
    const pm = Math.min(pa, rnd(5), fgm)
    const fta = rnd(9)
    const ftm = Math.min(fta, rnd(8))
    return { playerId, teamId, stats: { pts: 2 * fgm + pm + ftm, reb: 2 + rnd(10), ast: 1 + rnd(8), stl: rnd(3), blk: rnd(3), to: rnd(5), fgm, fga, '3pm': pm, '3pa': pa, ftm, fta } }
  }
  const lines = [...roster(home).map((p) => line(p, home)), ...roster(away).map((p) => line(p, away))]
  const sum = (team: string) => lines.filter((l) => l.teamId === team).reduce((s, l) => s + l.stats.pts!, 0)
  if (sum(home) === sum(away)) {
    const first = lines[0]!.stats
    first.pts!++
    first.ftm!++
    first.fta!++
  }
  return { lines, home: sum(home), away: sum(away) }
}

/** Four rounds played, every game with box lines. */
function playRounds(seed: number) {
  const rnd = random(seed)
  for (let round = 1; round <= 4; round++) {
    for (const g of listGames(db, currentSeason(db).id).filter((x) => x.round === round && x.status === 'scheduled')) {
      const box = boxScore(g.home, g.away, rnd)
      recordScore(db, { gameId: g.id, homeScore: box.home, awayScore: box.away, lines: box.lines })
    }
  }
}

/** The sentences the check would send back for a redo, with what it found. */
const flagged = (facts: Facts, sentences: readonly string[]) =>
  sentences.flatMap((s) => {
    const found = unknownNumbers(s, facts)
    return found.length ? [`${s} => ${found.join(', ')}`] : []
  })

const pct = (a: number, b: number, d = 1) => ((a / b) * 100).toFixed(d)
const SEEDS = [7, 11, 23, 31]

describe('honest writing passes the number check', () => {
  it.each(SEEDS)('a post-game thread (seed %i)', (seed) => {
    playRounds(seed)
    const league = readLeague(db, dir)
    const out: string[] = []
    for (const g0 of listGames(db, currentSeason(db).id).filter((g) => g.round === 4).slice(0, 2)) {
      const game = getGame(db, g0.id)!
      const input = gameThreadInput(league, game.id, lastNewsEventId(db))
      const facts = readFacts(input.context, input.instructions)
      const lines = boxLines(db, game.id)
      const homeWon = game.homeScore! > game.awayScore!
      const [W, L] = homeWon ? [game.home, game.away] : [game.away, game.home]
      const [ws, ls] = [Math.max(game.homeScore!, game.awayScore!), Math.min(game.homeScore!, game.awayScore!)]
      const top = (team: string) => lines.filter((l) => l.teamId === team).sort((a, b) => (b.stats.pts ?? 0) - (a.stats.pts ?? 0))
      const p1: Line = top(W)[0]!
      const p2: Line = top(W)[1]!
      const q1: Line = top(L)[0]!
      const nm = (l: Line) => league.players.get(l.playerId)!.name
      const s = (l: Line, k: string) => l.stats[k] ?? 0
      const tot = (team: string, k: string) => lines.filter((l) => l.teamId === team).reduce((sum, l) => sum + (l.stats[k] ?? 0), 0)
      const table = standings(db).overall
      const row = table.find((x) => x.teamId === W)!
      const [w, lo] = [short(league, W), short(league, L)]
      const winRate = Math.round((row.wins / (row.wins + row.losses)) * 1000)
      const fgW = Number(pct(tot(W, 'fgm'), tot(W, 'fga')))
      const fgL = Number(pct(tot(L, 'fgm'), tot(L, 'fga')))
      out.push(
        ...flagged(facts, [
          `${w} ${ws}-${ls} 승리, ${ws - ls}점 차`,
          `두 팀 합쳐 ${ws + ls}점 난타전이었다`,
          `${nm(p1)} ${s(p1, 'pts')}점 ${s(p1, 'reb')}리바 ${s(p1, 'ast')}어시, 야투 ${s(p1, 'fgm')}/${s(p1, 'fga')}`,
          `${nm(p1)} 야투율 ${pct(s(p1, 'fgm'), s(p1, 'fga'))}%`,
          `${nm(p1)} 야투 ${s(p1, 'fga')}개 던져서 ${s(p1, 'fgm')}개 넣음`,
          `${nm(p1)} 야투 ${s(p1, 'fga') - s(p1, 'fgm')}개 놓친 게 아쉽다`,
          `${nm(p1)} 3점 ${s(p1, '3pm')}/${s(p1, '3pa')}`,
          // Two players' points added up, named or not.
          `${nm(p1)}, ${nm(p2)} 둘이 ${s(p1, 'pts') + s(p2, 'pts')}점 합작`,
          `${nm(p1)} ${s(p1, 'pts')}점, ${nm(p2)} ${s(p2, 'pts')}점으로 둘이 ${s(p1, 'pts') + s(p2, 'pts')}점`,
          `${w} 팀 야투 ${tot(W, 'fgm')}/${tot(W, 'fga')}(${pct(tot(W, 'fgm'), tot(W, 'fga'))}%)`,
          `${w} 팀 야투율 ${pct(tot(W, 'fgm'), tot(W, 'fga'), 0)}%`,
          `${w} 3점 ${tot(W, '3pm')}/${tot(W, '3pa')}, ${pct(tot(W, '3pm'), tot(W, '3pa'))}%`,
          `${lo} 자유투 ${tot(L, 'ftm')}/${tot(L, 'fta')}로 ${pct(tot(L, 'ftm'), tot(L, 'fta'))}%`,
          `리바운드 ${tot(W, 'reb')}-${tot(L, 'reb')}, ${Math.abs(tot(W, 'reb') - tot(L, 'reb'))}개 차이`,
          `리바운드에서 ${Math.abs(tot(W, 'reb') - tot(L, 'reb'))}개 차이가 났다`,
          `어시스트 ${tot(W, 'ast')}개 대 ${tot(L, 'ast')}개`,
          `${lo} 턴오버 ${tot(L, 'to')}개가 패인`,
          `${w}가 ${lo}보다 야투 ${Math.abs(tot(W, 'fgm') - tot(L, 'fgm'))}개 더 넣었다`,
          `${w} 야투 ${tot(W, 'fgm')}개, ${lo} ${tot(L, 'fgm')}개로 ${Math.abs(tot(W, 'fgm') - tot(L, 'fgm'))}개 차이`,
          `${w} 3점 ${tot(W, '3pm')}개 대 ${lo} ${tot(L, '3pm')}개`,
          `${w} ${row.wins}승 ${row.losses}패, 전체 ${table.indexOf(row) + 1}위`,
          `${w} 승률 ${pct(row.wins, row.wins + row.losses, 0)}%`,
          `${w} 승률 0.${String(winRate).padStart(3, '0')}`,
          `${w} 승률 .${String(winRate).padStart(3, '0')}`,
          `${nm(q1)} 혼자 ${s(q1, 'pts')}점 분전했지만 졌다`,
          `${nm(q1)} ${s(q1, 'pts')}점 넣었는데 팀은 ${ws - ls}점 차로 짐`,
          `${nm(p1)} ${s(p1, 'pts')}-${s(p1, 'reb')}-${s(p1, 'ast')}`,
          `${nm(p1)} ${s(p1, 'pts')}점, 팀 ${ws}점 중 ${pct(s(p1, 'pts'), ws, 0)}%`,
          // Percentage points: the two sides' shooting apart.
          `${w} 야투 성공률 ${fgW.toFixed(1)}%, ${lo} ${fgL.toFixed(1)}% — ${Math.abs(fgW - fgL).toFixed(1)}%p 차이`,
          `야투율에서 ${Math.abs(fgW - fgL).toFixed(1)}%p 앞섰다`,
          `${w} 자유투 ${tot(W, 'fta')}개 얻어서 ${tot(W, 'ftm')}개 성공`,
          `${lo} 야투 ${tot(L, 'fga') - tot(L, 'fgm')}개 놓침`,
          `${nm(p1)} 이번 경기 ${s(p1, 'pts')}점 터뜨렸다`,
          `4쿼터에만 ${lo} 무너짐, ${ws - ls}점 차 대패`,
          `${nm(p2)} ${s(p2, 'pts')}점 ${s(p2, 'reb')}리바로 뒤를 받쳤다`,
          `${nm(p1)} 3점 ${s(p1, '3pa')}개 던져 ${s(p1, '3pm')}개`,
          // Threes made are points: 3점 4/9 is 12점.
          `${nm(p1)} ${s(p1, 'pts')}점 중 3점으로만 ${s(p1, '3pm') * 3}점`,
          `${w} 3점으로만 ${tot(W, '3pm') * 3}점`,
          `${w} 자유투로 ${tot(W, 'ftm')}점`,
        ]),
      )
    }
    expect(out).toEqual([])
  })

  it.each(SEEDS)('a wiki round edit, its season so far with totals (seed %i)', (seed) => {
    playRounds(seed)
    const league = readLeague(db, dir)
    const input = roundWikiInput(league, currentSeason(db).id, 4)!
    const facts = readFacts(input.context, input.instructions)
    const lines = input.context.split('\n')
    const season = lines.filter((l) => l.startsWith('- ') && l.includes('경기 평균'))
    expect(season.length).toBeGreaterThan(0)
    const out: string[] = []
    for (const line of season) {
      const m =
        /^- (\S+): (\d+)경기 평균 ([\d.]+)점 ([\d.]+)리바 ([\d.]+)어시\(총 (\d+)점 (\d+)리바 (\d+)어시\) · 시즌 최고 (\d+)점.*?(?:득점 (\d+)위)?.*소속 (\S+) (\d+)승 (\d+)패(?:\((\d+)(연승|연패)\))?, 전체 (\d+)위/.exec(
          line,
        )
      expect(m, line).not.toBeNull()
      const [, name, games, avg, reb, ast, total, rebs, , high, rank, team, wins, losses, run, kind, place] = m!
      const night = lines.find((l) => /^- R4 /.test(l) && l.includes(`${name}(`))
      const r4 = night ? /\) (\d+)점 (\d+)리바 (\d+)어시.*\(야투 (\d+)\/(\d+), 3점 (\d+)\/(\d+)\)/.exec(night) : null
      const gap = (Number(high) - Number(avg)).toFixed(1)
      out.push(
        ...flagged(
          facts,
          [
            `${name}는 ${games}경기 평균 ${avg}점 ${reb}리바 ${ast}어시를 기록 중이다.`,
            `시즌 최고 득점은 ${high}점이다.`,
            rank ? `득점 부문 ${rank}위에 올라 있다.` : '',
            `소속팀 ${team}은 ${wins}승 ${losses}패${run ? `(${run}${kind})` : ''}로 전체 ${place}위다.`,
            `${team} 승률 ${pct(Number(wins), Number(wins) + Number(losses), 0)}%`,
            `평균 ${Number(avg).toFixed(0)}점대 초반`,
            `경기당 ${avg}점, ${reb}리바운드`,
            // Totals: written for the editors, not worked out by them.
            `${games}경기에서 총 ${Math.round(Number(avg) * Number(games))}점을 넣었다.`,
            `${games}경기 동안 리바운드 ${rebs}개, 득점 ${total}점`,
            `시즌 최고 ${high}점, 평균보다 ${gap}점 높다.`,
            r4 ? `R4에서 ${r4[1]}점 ${r4[2]}리바를 올렸다.` : '',
            r4 ? `R4에서 야투 ${r4[4]}/${r4[5]}(${pct(Number(r4[4]), Number(r4[5]))}%)` : '',
            r4 ? `R4 ${r4[1]}점은 시즌 평균(${avg}점)보다 ${(Number(r4[1]) - Number(avg)).toFixed(1)}점 많다.` : '',
            r4 ? `이날 ${r4[1]}점은 시즌 최고 ${high}점에 ${Number(high) - Number(r4[1])}점 모자랐다.` : '',
            `시즌 평균 득점이 ${avg}점에서 최고 ${high}점까지 오르내렸다.`,
          ].filter(Boolean),
        ),
      )
    }
    expect(out).toEqual([])
  })

  it.each(SEEDS)('chatter on its topics’ facts (seed %i)', (seed) => {
    playRounds(seed)
    const league = readLeague(db, dir)
    const out: string[] = []
    const seen = new Set<string>()
    for (let t = 0; t < 12; t++) {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T12:00:00Z') + t + seed * 100)
      const input = chatterInput(league)
      spy.mockRestore()
      const facts = readFacts(input.context, input.instructions)
      const sentences: string[] = []
      for (const line of input.context.split('\n')) {
        let m = /자료: 1\. (\S+)\(\S+\) ([\d.]+)% · (\d+)경기 \/ 2\. (\S+)\(\S+\) ([\d.]+)%/.exec(line)
        if (m) {
          const gap = (Number(m[2]) - Number(m[5])).toFixed(1)
          sentences.push(`${m[1]} 야투율 ${m[2]}%로 1위, ${m[3]}경기 뛰었음`, `${m[1]}랑 ${m[4]} ${gap}%p 차이`, `1위 ${m[2]}%, 2위 ${m[5]}%, ${gap}%p 차이`)
        }
        m = /자료: 1\. (\S+)\(\S+\) ([\d.]+) · (\d+)경기 · 총 (\d+) \//.exec(line)
        if (m) sentences.push(`${m[1]} 경기당 ${m[2]}개로 1위`, `${m[1]} ${m[3]}경기에서 ${Math.round(Number(m[2]) * Number(m[3]))}개`)
        m = /자료: 1위 (\S+) (\d+)승 (\d+)패/.exec(line)
        if (m) sentences.push(`${m[1]} ${m[2]}승 ${m[3]}패 1위, 승률 ${pct(Number(m[2]), Number(m[2]) + Number(m[3]), 0)}%`, `${m[1]} 이대로면 우승이지 ${m[2]}승 ${m[3]}패인데`)
        m = /다음 경기: (\S+) @ (\S+)/.exec(line)
        // A prediction post: a score for a fixture, a title chance, a call.
        if (m) sentences.push(`${m[1]} @ ${m[2]}: ${m[2]} 95:88 승`, `${m[2]} 우승 확률 80%`, `${m[2]} 이대로 가면 23승 각`, `내가 박제한다 ${m[2]} 23승`)
        m = /자료: (?:R\d+ )?(\S+) (\d+) : (\d+) (\S+)$/.exec(line)
        if (m) sentences.push(`${m[1]} ${m[2]}:${m[3]} ${m[4]} 이 경기 다시 봐도 어이없음, ${Math.abs(Number(m[2]) - Number(m[3]))}점 차`, `${Number(m[2]) + Number(m[3])}점 난타전`)
        m = /자료: 1\. (\S+)\(\S+\) OVR (\d+) \/ 2\. (\S+)\(\S+\) OVR (\d+)/.exec(line)
        if (m) sentences.push(`${m[1]} OVR ${m[2]}로 1위, ${m[3]} OVR ${m[4]}`)
        m = /정규시즌 (\d+)\/(\d+)경기 진행/.exec(line)
        // A share of the schedule (16/28경기) and what's left of it.
        if (m) sentences.push(`벌써 ${m[2]}경기 중 ${m[1]}경기 끝남, ${pct(Number(m[1]), Number(m[2]), 0)}% 지났다`, `정규시즌 ${Number(m[2]) - Number(m[1])}경기 남았다`)
      }
      for (const text of sentences.filter((x) => !seen.has(x))) {
        seen.add(text)
        out.push(...flagged(facts, [text]))
      }
    }
    expect(seen.size).toBeGreaterThan(10)
    expect(out).toEqual([])
  })

  it('a playoff series: its standouts with totals, and the series as a win rate', async () => {
    // The regular season (scores only), already written about; then East's only round, t1 over t2 4-2, with box lines.
    for (;;) {
      const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && g.stage === 'regular')
      if (open.length === 0) break
      for (const g of open) recordScore(db, { gameId: g.id, homeScore: 100, awayScore: 90, lines: null })
    }
    setStoryValue(db, 'events-handled', String(lastEventId(db)))
    startPlayoffs(db)
    await ai.queueFor('test', db, dir).kick()
    const series = playoffsView(db).series.find((s) => s.slot === 'east:r1:0')!
    const rnd = random(5)
    for (const highWins of [true, true, false, true, false, true]) {
      const g = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series.id && x.status === 'scheduled')!
      const box = boxScore(g.home, g.away, rnd)
      const winner = highWins ? series.high! : g.home === series.high ? g.away : g.home
      const loser = winner === g.home ? g.away : g.home
      const sum = (team: string) => box.lines.filter((l) => l.teamId === team).reduce((s, l) => s + l.stats.pts!, 0)
      // The winner's best scorer makes up the difference from the line.
      const behind = sum(loser) - sum(winner) + 1
      if (behind > 0) {
        const star = box.lines.find((l) => l.teamId === winner)!.stats
        star.pts! += behind
        star.ftm! += behind
        star.fta! += behind
      }
      recordScore(db, { gameId: g.id, homeScore: sum(g.home), awayScore: sum(g.away), lines: box.lines })
    }
    story.afterChange('test', db, dir)
    const job = db.prepare('SELECT input FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(WIKI_EDITS) as { input: string }
    const input = JSON.parse(job.input) as { context: string; instructions: string }
    const facts = readFacts(input.context, input.instructions)
    const result = /: (\S+)가 (\S+)를 4-2로 꺾음/.exec(input.context)
    expect(result).not.toBeNull()
    const winner = result![1]!
    const stars = [...input.context.matchAll(/시리즈 활약: (\S+)\(\S+\) (\d+)경기 평균 ([\d.]+)점 ([\d.]+)리바 ([\d.]+)어시\(총 (\d+)점 (\d+)리바 (\d+)어시\)/g)]
    expect(stars.length).toBeGreaterThan(1)
    const sentences = [`${winner}가 4승 2패로 시리즈를 끝냈다.`, '6경기 만에 시리즈 종료', '시리즈 승률 66.7%', `${winner} 시리즈 승률 67%`]
    for (const [, name, games, avg, reb, ast, total, rebs] of stars) {
      sentences.push(
        `${name}는 시리즈 ${games}경기 평균 ${avg}점 ${reb}리바 ${ast}어시로 활약했다.`,
        `${name} 시리즈 평균 ${avg}점 ${Math.round(Number(reb))}리바`,
        `${name} ${games}경기 평균 ${avg}점, 총 ${total}점`,
        `${name}는 시리즈에서 리바운드 ${rebs}개를 잡았다`,
        `${name}는 경기당 ${avg}득점을 올렸다.`,
      )
    }
    const [a, b] = stars as [RegExpExecArray, RegExpExecArray]
    sentences.push(`${a[1]} 평균 ${a[3]}점, ${b[1]} 평균 ${b[3]}점으로 ${(Number(a[3]) - Number(b[3])).toFixed(1)}점 앞섰다`)
    expect(flagged(facts, sentences)).toEqual([])
  })
})

/** A game's facts, as a post-game thread gets them. */
const GAME = `# 이 경기
R4 · 가람고 81 : 77 나람고 (홈: 가람고)
가람고: 가가가 31점 9리바 4어시 2스틸 (야투 12/20, 3점 3/7) / 가나나 18점 5리바 6어시 (야투 7/15, 3점 2/6)
나람고: 나나나 27점 11리바 3어시 (야투 10/19, 3점 4/9)
팀 합계: 가람고 야투 30/66, 3점 8/24, 자유투 13/18, 리바 40, 어시 19, 턴오버 12 / 나람고 야투 28/70, 3점 9/30, 자유투 12/16, 리바 35, 어시 15, 턴오버 14
# 순위 (상위 10)
1. 가람고 5승 3패 (W2)
2. 나람고 4승 4패 (L1)`

/** A prediction post's facts, as chatter gets them. */
const PREDICTION = `# 리그
테스트 리그 · 시즌 1 · 정규시즌 · 정규시즌 16/28경기 진행
# 순위 (상위 10)
1. 나람고 3승 1패 (W3)
2. 라람고 3승 1패 (L1)
3. 다람고 2승 2패 (L2)
# 이번에 쓸 글
5. [예언·박제 · 게시판 main] 대담한 예언 글
   자료: 1위 나람고 3승 1패 / 2위 라람고 3승 1패 / 다음 경기: 바람고 @ 나람고 / 다음 경기: 마람고 @ 라람고`

describe('honest writing passes the number check: one game, predictions and hopes', () => {
  it('reads a game the way fans put it', () => {
    expect(
      flagged(readFacts(GAME), [
        '가가가 31점, 가나나 18점 둘이 49점 합작',
        '가가가, 가나나 둘이 49점',
        '가가가 3경기 연속 20점',
        '가람고 2연승, 승률 62.5%',
        '가람고 승률 .625',
        '가람고 5승 3패로 1위, 나람고와 1경기 차',
        '가람고 야투 30/66(45.5%)',
        '가람고 야투율 45%',
        '가가가 야투 12/20 60%',
        '리바운드 40-35',
        '가람고 리바운드 5개 더 잡음',
        '턴오버 12개 vs 14개, 2개 차이',
        '야투율 45.5% vs 40%, 5.5%p 차이',
        '야투율에서 5.5%p 앞섰다',
        '3점 성공률 33.3% vs 30%',
        '가가가 31점, 팀 81점 중 38%',
        '가가가 31점 중 9점이 3점',
        '가가가 3점 3개로 9점',
        '가람고 3점으로만 24점',
        '자유투 13/18, 72.2%',
        '81-77, 4점 차 신승',
        '가가가 31-9-4',
        '나나나 27점 11리바 더블더블, 그래도 졌다',
        '가가가 31점 vs 나나나 27점, 에이스 대결은 4점 차로 가가가 승',
        '가가가 야투 8개 놓침, 나나나는 9개',
      ]),
    ).toEqual([])
  })

  it('doesn’t check predictions, conditions, hopes and what should have been', () => {
    expect(
      flagged(readFacts(GAME), [
        '41점 넣을 줄 알았는데 31점',
        '41점 찍을 기세였음',
        '41점 넣을 수도 있었는데 31점에 그침',
        '41점 넣을 거라고 했잖아',
        '41점 넣었으면 이겼을 텐데',
        '41점 넣었으면 좋겠다',
        '가가가 다음 경기 41점 넣을 듯',
        '이 기세면 41점 찍겠네',
        '가람고 10연승 간다',
        '다음 경기는 30점 차로 이긴다',
        '가가가 50점 가즈아',
        '목표는 시즌 20승',
        '내 예상 스코어 95:88',
        '가가가 다음 경기 40점 넣을거임',
        '나람고 41점 차로 질 것 같다',
        '다음엔 20점 차로 이기자',
        '가가가 40점은 넣어야 이긴다',
        '최소 41점은 넣어야 함',
        '나람고 41점 차로 질걸',
        '이번 시즌 60승 할 거다',
        '시즌 끝나면 25.5점 찍어있을 듯',
        '가가가 40점 넣으면 인정',
        '다음 경기도 41점 넣길 바란다',
        '다음 경기 41점 기대해본다',
        '다음 경기엔 41점 했으면',
        '다음 경기엔 57점 넣어라',
        '다음 경기는 꼭 57점 차로 이겨라',
        '다음 경기도 57점 부탁',
        '57점 넣어줘',
        '57점 넣어주세요',
        '언젠가 50점 넣는 날 온다',
        '57점 넣어야지',
        '57점은 넣었어야지',
        '앞으로 3경기 남음',
        '이번엔 진짜 57점 넣는다',
        '57점 넣고 싶다',
        '57점 넣고 싶었는데',
        '가가가 57점 넣어줬으면',
        '가가가 57점 넣을 것',
        '가가가는 57점을 넣는 선수가 될 것이다',
        '57점 넣으면 MVP 확정',
        '57점은 넣을 줄 알았다',
      ]),
    ).toEqual([])
    expect(
      flagged(readFacts(PREDICTION), [
        '나람고 우승 확률 80%',
        '나람고 우승 확률 80%라고 본다',
        '바람고전 다음 경기 20점 차 승',
        '나람고 이대로 가면 23승 각',
        '나람고 이대로 가면 23승',
        '나람고 23승 각이다',
        '내가 박제한다 나람고 23승',
        '시즌 MVP 가가가, 평균 35점 찍는다',
        '나람고 시즌 23승 5패 예상',
        '나람고 23승 5패로 끝날 거임',
        '나람고 23승 5패로 끝내자',
        '라람고 이번 시즌 15승은 무조건',
        '라람고 15승 못 하면 삭발함',
        '라람고 15승 못하면 내가 탈퇴',
        '마람고 @ 라람고: 라람고 95:88 승',
        '스코어 95:88 간다',
        '벌써 28경기 중 16경기 끝남, 57% 지났다',
      ]),
    ).toEqual([])
  })
})

describe('made-up numbers are caught', () => {
  it('as claims, whatever words around them look ahead', () => {
    const missed = (facts: Facts, texts: string[]) => texts.filter((t) => unknownNumbers(t, facts).length === 0)
    expect(
      missed(readFacts(GAME), [
        '가가가 오늘 60점 넣었다',
        '다음 시즌엔 몰라도 이번엔 41점 넣었다',
        '가가가 41점 넣을 뻔했다',
        '다음 상대 나람고는 지난 경기 41점 차 대패',
        '내일 만나는 나람고, 직전 경기 55점 폭발한 팀임',
        '내일 만나는 나람고, 직전 경기 55점 폭발',
        '지난번엔 졌지만 이번엔 41점 차 대승',
        '이번엔 가가가가 41점 넣음',
        '개막전 다음 경기에서 41점 넣음',
        '앞으로 주목할 선수: 가가가 야투율 85%',
        '가가가 41점 넣으면 뭐함 팀이 졌는데',
        '41점 넣으면 뭐해 수비를 안 하는데',
        '41점 넣으면 뭐함',
        '가가가 41점 넣으면서 팀을 구했다',
        '이번 시즌 41점 넣은 적 있음?',
        '내일 경기 앞두고 가가가 시즌 평균 57점',
        '예상대로 가가가 57점 폭발',
        '예상과 달리 가가가 57점',
        '내 예언 적중, 가가가 57점',
        '목표 달성, 시즌 57승',
        '그 다음 쿼터에 57점',
        '이번엔 57점 차 대승',
        '이번 경기 57점 차',
        '57점 넣으면 뭐하냐 졌는데',
        '57점 넣을 줄은 몰랐다',
        '57점 넣을 줄 누가 알았냐',
        '38점 넣은 그 장면',
        '가가가는 매 경기 47점은 넣는다',
        '오늘 가가가 47점 터짐',
        '나나나 27점 11리바, 합쳐서 38',
        '가가가 야투율 61%',
        '야투율에서 21.5%p 앞섰다',
        '가람고 승률 .700',
      ]),
    ).toEqual([])
    expect(missed(readFacts(PREDICTION), ['나람고 23승 5패로 끝남', '나람고 지난 시즌 23승'])).toEqual([])
  })
})
