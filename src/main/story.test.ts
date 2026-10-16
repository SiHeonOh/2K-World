import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { bufferSize, lastEventId, listPersonas, openPost, setStoryValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { appendEvent, currentSeason, listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { applyTrade, closeProtection, draftMove, draftView, giveAward, listAwards, removeAward, vetoDraftSwap, vetoTrade } from '@data/moves'
import { finishPlayoffs, listGames, playoffsView, recordScore, startPlayoffs, startSeason, unrecordGame } from '@data/season'
import { defaultCardSwap } from '@shared/config/defaults'
import { addScheduledGame, clearRound, fillRound, scheduleOptions } from '@data/schedule'
import { storyDemo, storyKinds } from '@story/jobs'
import { STANDINGS_NOTE } from '@story/context'
import { WIKI_EDITS, WIKI_RETRY_PRIORITY, wikiEditDemo, wikiEditKind, type WikiEditInput } from '@story/wikiEdits'
import { writtenItem } from '@story/wikiOccasions'
import { leagueChampion } from '@shared/season'
import { pageByRef, pageByTitle, revisionBody, saveRevision } from '@data/wiki'
import type { JobRow } from '@ai/queue'
import { AiService } from './ai'
import { LoreService } from './lore'
import { StoryService } from './story'
import { WikiService } from './wiki'

const SECRET = '사실은 전학을 원한다'

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-story-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  seedLeague(db, setup)
  const team = listTeams(db)[0]!
  const player = setup.players.find((p) => p.teamId === team.id)!
  mkdirSync(join(dir, 'lore', 'teams', team.shortName), { recursive: true })
  writeFileSync(join(dir, 'lore', 'teams', team.shortName, `${team.shortName}.md`), `---\nid: ${team.shortName}\nfans:\n  size: 5\n---\n## 공개\n전통의 강호.\n`)
  writeFileSync(
    join(dir, 'lore', 'teams', team.shortName, `${player.name}.md`),
    `---\nid: ${player.name}\n---\n## 공개\n팀의 에이스.\n\n## 소문\n감독과 불화설.\n\n## 비밀\n${SECRET}\n`,
  )
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  await ai.refresh()
  story = new StoryService(ai)
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const later = () => Date.now() + 60 * 60_000
const drain = () => ai.queueFor('test', db, dir).kick()
const jobs = () => db.prepare('SELECT kind, status, input FROM jobs ORDER BY id').all() as { kind: string; status: string; input: string }[]
const wikiJobs = () => jobs().filter((j) => j.kind === 'wiki_edits')
const wikiInput = (j: { input: string }) => JSON.parse(j.input) as { instructions: string; context: string; pages: string[] }
const nameOf = (id: string) => listPlayers(db).find((p) => p.id === id)!.name
const schoolOf = (teamId: string) => listTeams(db).find((t) => t.id === teamId)!.shortName
/** Texts saved with numbers their facts don't hold: what the number check would have redone. */
const flags = () => (db.prepare('SELECT COUNT(*) AS n FROM ai_flags').get() as { n: number }).n
const awardId = (awardId: string, period = '') => listAwards(db, currentSeason(db).id).find((a) => a.awardId === awardId && a.period === period)!.id
const setCommunity = (enabled: boolean) => story.saveSettings(db, { ...loadConfig(db).config.community, enabled })
/** A look at the league with nothing for the wiki in it: a news item typed in. */
const news = () => void story.news('test', db, dir, '연습 경기 일정이 나왔다.')
/** Flips the score of a series' last game played, so its other school won that one. */
function flipLastGame(seriesId: number): void {
  const g = listGames(db, currentSeason(db).id)
    .filter((x) => x.seriesId === seriesId && x.status === 'final')
    .sort((a, b) => a.round - b.round)
    .at(-1)!
  recordScore(db, { gameId: g.id, homeScore: g.awayScore!, awayScore: g.homeScore!, lines: null })
}

/** Plays every scheduled game of these stages, again and again (playoff series add games): the lower-numbered school wins. */
function playAll(stages: (stage: string) => boolean): void {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && stages(g.stage))
    if (open.length === 0) return
    for (const g of open) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}

/** The story mark moved past everything so far, as if it had all been written about already. */
const caughtUp = () => setStoryValue(db, 'events-handled', String(lastEventId(db)))

/** The regular season played out, already written about. */
function playRegularSeason(): void {
  startSeason(db)
  playAll((s) => s === 'regular')
  caughtUp()
}

/** Plays one series game by game: `highWins` says who takes each game, `lines` gives each game's box lines. */
function playSeries(slot: string, highWins: boolean[], lines?: (game: number) => { playerId: string; teamId: string; stats: Record<string, number> }[]) {
  const series = playoffsView(db).series.find((s) => s.slot === slot)!
  highWins.forEach((win, i) => {
    const g = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series.id && x.status === 'scheduled')!
    const homeWins = win === (g.home === series.high)
    recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: lines?.(i) ?? null })
  })
  return series
}

/** A card-swap league played through to the draft's swap turns, already written about. */
function toDraft(): void {
  db.prepare("UPDATE league_config SET json = json_set(json, '$.draft', json(?))").run(JSON.stringify(defaultCardSwap(8)))
  startSeason(db)
  playAll((s) => s === 'regular')
  startPlayoffs(db)
  playAll((s) => s !== 'regular')
  finishPlayoffs(db)
  closeProtection(db)
  caughtUp()
}

/** The school on the clock swaps its first unprotected player for the first one it may take. */
function swap() {
  const view = draftView(db)
  const card = view.next!
  const taken = new Set(view.protectedPlayers)
  const own = listPlayers(db).find((p) => p.teamId === card.ownerTeamId && !taken.has(p.id))!
  const target = listPlayers(db).find((p) => p.teamId !== card.ownerTeamId && !taken.has(p.id))!
  const id = draftMove(db, { kind: 'swap', teamId: card.ownerTeamId, cardId: card.id, playerId: own.id, targetPlayerId: target.id })
  return { id, own, target, by: card.ownerTeamId, from: target.teamId }
}

describe('StoryService (demo writer)', () => {
  it('reacts to games and the season start, and never hands writers a secret', async () => {
    startSeason(db)
    const loreTeam = listTeams(db)[0]!.id
    const game = listGames(db, 1).find((g) => g.home === loreTeam || g.away === loreTeam)!
    recordScore(db, { gameId: game.id, homeScore: 81, awayScore: 77, lines: null })
    expect(story.afterChange('test', db, dir)).toBe(2)
    expect(story.afterChange('test', db, dir)).toBe(0)
    await drain()
    expect(jobs().map((j) => [j.kind, j.status])).toEqual([
      ['post_game_thread', 'done'],
      ['event_thread', 'done'],
    ])
    for (const j of jobs()) expect(j.input).not.toContain(SECRET)
    expect(jobs()[0]!.input).toContain('전통의 강호')
    // Fans of both schools get a say.
    const cast = JSON.parse(jobs()[0]!.input).demo.fans as string[]
    const teamsOf = new Set(cast.map((id) => (db.prepare('SELECT team_id FROM personas WHERE id = ?').get(id) as { team_id: string | null }).team_id))
    expect(teamsOf.has(game.home) && teamsOf.has(game.away)).toBe(true)
    const { community } = loadConfig(db).config
    const games = story.board(db, dir, 'games', 1)
    expect(games.posts.some((p) => p.title.startsWith('[경기 후]'))).toBe(true)
    const thread = openPost(db, community, games.posts.find((p) => p.title.startsWith('[경기 후]'))!.id, later())
    expect(thread.thread.length).toBeGreaterThan(5)
    expect(thread.gameId).toBe(game.id)
    expect(story.status('test', db).personas).toBe(community.fans + community.reporters)
  })

  it('refills chatter on refresh and reveals it a few at a time', async () => {
    story.afterChange('test', db, dir)
    const first = story.refresh('test', db, dir, () => 0.5)
    expect(first).toMatchObject({ revealed: 0, refilling: true, budgetSpent: false })
    await drain()
    const waiting = bufferSize(db)
    expect(waiting).toBeGreaterThan(4)
    const second = story.refresh('test', db, dir, () => 0.5)
    expect(second.revealed).toBe(loadConfig(db).config.community.revealPerRefresh)
    expect(second.waiting).toBe(waiting - second.revealed)
  })

  it('refills chatter again on the next refresh once you cancel the batch being written', async () => {
    story.afterChange('test', db, dir)
    expect(story.refresh('test', db, dir, () => 0.5).refilling).toBe(true)
    const batches = () => jobs().filter((j) => j.kind === 'chatter_batch')
    // One batch at a time: while it's on its way, a refresh adds none.
    expect(story.refresh('test', db, dir, () => 0.5).refilling).toBe(true)
    expect(batches()).toHaveLength(1)
    const batch = (db.prepare("SELECT id FROM jobs WHERE kind = 'chatter_batch'").get() as { id: number }).id
    ai.cancel('test', db, dir, batch)
    expect(story.status('test', db).writing).toBe(0)
    // Its answer is dropped: nothing reaches the buffer.
    await drain()
    expect(bufferSize(db)).toBe(0)
    expect(story.refresh('test', db, dir, () => 0.5)).toMatchObject({ refilling: true, budgetSpent: false })
    expect(batches().map((j) => j.status)).toEqual(['cancelled', 'running'])
    await drain()
    expect(bufferSize(db)).toBeGreaterThan(4)
  })

  it('answers your posts and comments, and turns news into an event thread', async () => {
    story.afterChange('test', db, dir)
    const ace = sampleSetup().players.find((p) => p.teamId === listTeams(db)[0]!.id)!.name
    const id = story.writePost('test', db, dir, { boardId: 'free', title: '질문 있어요', body: `${ace} 요즘 어때?` })
    // The page keeps looking while the reply is still queued (nothing is pending yet).
    expect(story.post(db, id)).toMatchObject({ pending: 0, writing: true })
    await drain()
    expect(story.post(db, id).writing).toBe(false)
    // The player you named: 공개 and 소문 (marked), never 비밀.
    const replyJob = jobs().find((j) => j.kind === 'reply_to_user')!
    expect(replyJob.input).toContain('감독과 불화설')
    expect(replyJob.input).not.toContain(SECRET)
    const { community } = loadConfig(db).config
    const view = openPost(db, community, id, later())
    expect(view.thread.length).toBeGreaterThanOrEqual(2)
    const mine = story.writeComment('test', db, dir, { postId: id, body: '나는 가람고 봄' })
    expect(story.post(db, id).writing).toBe(true)
    await drain()
    const again = openPost(db, community, id, later())
    expect(again.thread.some((c) => c.parentId === mine)).toBe(true)

    story.news('test', db, dir, '감독 경질설이 돌고 있다')
    await drain()
    expect(jobs().filter((j) => j.kind === 'event_thread' && j.status === 'done')).toHaveLength(1)
  })

  it('writes a round-up once a round is complete', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const round1 = listGames(db, 1).filter((g) => g.round === 1)
    for (const g of round1) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    const roundUps = jobs().filter((j) => j.kind === 'event_thread' && j.input.includes('"instructions":"R1 라운드 정리다."'))
    expect(roundUps).toHaveLength(1)
    // Recording a correction later doesn't write it again.
    recordScore(db, { gameId: round1[0]!.id, homeScore: 91, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    expect(jobs().filter((j) => j.input.includes('"instructions":"R1 라운드 정리다."'))).toHaveLength(1)
  })

  it('lets fans bring back your own past takes, the ones about the game first', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const game = listGames(db, 1).find((g) => g.round === 1)!
    const home = listTeams(db).find((t) => t.id === game.home)!
    const other = listTeams(db).find((t) => t.id !== game.home && t.id !== game.away)!
    const main = loadConfig(db).config.community.boards.find((b) => b.role === 'main')!.id
    const take = story.writePost('test', db, dir, { boardId: main, title: `${home.shortName} 이번 시즌 4강 간다`, body: '두고 봐라' })
    story.writeComment('test', db, dir, { postId: take, body: 'ㅋㅋㅋ' })
    story.writePost('test', db, dir, { boardId: main, title: `${other.shortName} 올해는 꼴찌각`, body: '' })
    // The reply to that post doesn't quote the post back as an old take.
    const replies = jobs().filter((j) => j.kind === 'reply_to_user')
    expect(JSON.parse(replies[0]!.input).context).not.toContain('# 내가 전에 한 말')
    await drain()
    recordScore(db, { gameId: game.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    const thread = JSON.parse(jobs().filter((j) => j.kind === 'post_game_thread').at(-1)!.input).context as string
    const takes = thread.slice(thread.indexOf('# 내가 전에 한 말'))
    expect(takes).toContain('개막 전 · 내 글:')
    // The take about this game's school comes first; "ㅋㅋㅋ" isn't a take.
    expect(takes.indexOf(`${home.shortName} 이번 시즌 4강 간다`)).toBeLessThan(takes.indexOf(`${other.shortName} 올해는 꼴찌각`))
    expect(takes).not.toContain('ㅋㅋㅋ')
  })

  it('posts standings moments (a new #1, streaks, clinches) in one thread per look', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    for (let round = 1; round <= 5; round++) {
      for (const g of listGames(db, 1).filter((x) => x.round === round)) {
        const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
      story.afterChange('test', db, dir)
      await drain()
    }
    const threads = jobs().filter((j) => j.kind === 'event_thread' && j.input.includes('순위 소식'))
    expect(threads.length).toBeGreaterThan(0)
    // Five straight wins for the best school is news, with the standings note telling writers how to cover it.
    expect(threads.some((j) => j.input.includes('5연승 행진'))).toBe(true)
    expect(JSON.parse(threads[0]!.input).instructions).toBe(STANDINGS_NOTE)
  })

  it('records standings moments while the community is off, and doesn’t post them once it’s back on', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const community = loadConfig(db).config.community
    story.saveSettings(db, { ...community, enabled: false })
    const play = (round: number) => {
      for (const g of listGames(db, 1).filter((x) => x.round === round)) {
        const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
      story.afterChange('test', db, dir)
    }
    for (let round = 1; round <= 5; round++) play(round)
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'standings_moment'").get()).not.toEqual({ n: 0 })
    story.saveSettings(db, { ...community, enabled: true })
    play(6)
    await drain()
    // Only round 6's own news may be posted: not the best school's streak of five, recorded while the community was off.
    const best = listTeams(db).find((t) => t.id === 't1')!.shortName
    const posted = jobs().filter((j) => j.kind === 'event_thread' && j.input.includes('순위 소식'))
    for (const j of posted) expect(j.input).not.toContain(`${best}, 5연승 행진`)
  })

  it('waits for a round built by hand to be full before its round-up', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    // Round 2 rebuilt by hand: one game so far, played.
    clearRound(db, 2)
    addScheduledGame(db, { round: 2, home: 't1', away: scheduleOptions(db, 2, 't1').options.find((o) => o.status === 'ok')!.teamId })
    for (const g of listGames(db, 1).filter((x) => x.round === 2)) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    const roundUp = () => jobs().filter((j) => j.input.includes('"instructions":"R2 라운드 정리다."'))
    expect(roundUp()).toHaveLength(0)
    fillRound(db, 2)
    for (const g of listGames(db, 1).filter((x) => x.round === 2 && x.status === 'scheduled')) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    expect(roundUp()).toHaveLength(1)
  })

  it('has wiki editors note a round on the top performers pages, leaving your sections alone', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const round1 = listGames(db, 1).filter((g) => g.round === 1)
    const [first, ...rest] = round1
    const star = listTeams(db).find((t) => t.id === first!.home)!
    const ace = sampleSetup().players.find((p) => p.teamId === star.id)!
    recordScore(db, { gameId: first!.id, homeScore: 90, awayScore: 80, lines: [{ playerId: ace.id, teamId: star.id, stats: { pts: 35, reb: 9, ast: 4 } }] })
    story.afterChange('test', db, dir)
    await drain()
    // You open the wiki and write the 여담 section of the ace's page before the round ends.
    new WikiService().ensure(db, dir, true)
    const page = pageByTitle(db, ace.name)!
    const body = revisionBody(db, page.id, page.currentRev!)!.body.replace('== 여담 ==', '== 여담 ==\n내가 쓴 여담.')
    saveRevision(db, { title: ace.name, body, authorId: 'me', summary: '여담' }, Date.now())
    for (const g of rest) recordScore(db, { gameId: g.id, homeScore: 70, awayScore: 60, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    expect(jobs().filter((j) => j.kind === 'wiki_edits').map((j) => j.status)).toEqual(['done'])
    const wiki = JSON.parse(jobs().find((j) => j.kind === 'wiki_edits')!.input) as { context: string; season: string }
    // Editors get the season so far, worked out by code, and the season paragraph's title.
    expect(wiki.season).toBe('시즌 1')
    expect(wiki.context).toContain(`${ace.name}: 1경기 평균 35.0점 9.0리바 4.0어시 · 시즌 최고 35점 · 득점 1위`)
    expect(wiki.context).toContain("시즌 1 (이번 시즌 문단, 아직 없음: append로 쓰면 '시즌별 활약' 아래에 생긴다)")
    const after = pageByTitle(db, ace.name)!
    // The demo editor appends to 여담, which is yours: no edit lands there. Its season paragraph does.
    expect(after.currentRev).toBe(page.currentRev! + 2)
    const text = revisionBody(db, after.id, after.currentRev!)!.body
    expect(text).toContain('내가 쓴 여담.')
    expect(text).toMatch(/== 시즌별 활약 ==\n\[기록\]\n=== 시즌 1 ===\nR1 .+35점.+\.\n== 역사 ==/)

    // An editor who looked before that paragraph was written can't rewrite it, but can still add elsewhere.
    type Edit = { page: string; section: string; mode: 'append' | 'replace'; text: string; summary: string; editor: string }
    const edit = (section: string, mode: 'append' | 'replace', text: string): Edit => ({ page: ace.name, section, mode, text, summary: '편집', editor: 'f001' })
    const current = () => pageByTitle(db, ace.name)!.currentRev!
    const accept = (seen: number, edits: Edit[]) => {
      const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_edits', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
      const input = { pages: [ace.name], seen: { [ace.name]: seen }, editors: ['f001'], season: '시즌 1' }
      wikiEditKind(db).accept!({ edits, disputes: [] }, { id, input } as unknown as JobRow)
      return revisionBody(db, after.id, current())!.body
    }
    const stale = accept(after.currentRev! - 1, [edit('시즌 1', 'replace', '늦게 온 덮어쓰기.'), edit('별명', 'append', '늦게 온 덧붙임.')])
    expect(stale).toContain('늦게 온 덧붙임.')
    expect(stale).not.toContain('늦게 온 덮어쓰기.')
    expect(accept(current(), [edit('시즌 1', 'replace', '늦게 온 덮어쓰기.')])).toContain('=== 시즌 1 ===\n늦게 온 덮어쓰기.\n')
    // Writing in the table's place lands in the season paragraph instead.
    expect(accept(current(), [edit('시즌별 활약', 'append', '표 자리에 쓴 글.')])).toContain('[기록]\n=== 시즌 1 ===\n늦게 온 덮어쓰기.\n표 자리에 쓴 글.\n== 역사 ==')
    // A section longer than the editors were shown can't be rewritten: they'd drop what they never saw.
    const long = '긴 개요. '.repeat(120)
    const longBody = revisionBody(db, after.id, current())!.body.replace('== 개요 ==\n', `== 개요 ==\n${long}\n`)
    saveRevision(db, { title: ace.name, body: longBody, authorId: 'system', summary: '긴 개요' }, Date.now())
    expect(accept(current(), [edit('개요', 'replace', '짧은 개요.')])).toContain(long.trim())
  })

  it("refiles traded players' wiki pages under their new schools, and back when the trade is undone, community on or off", () => {
    startSeason(db)
    new WikiService().ensure(db, dir, true)
    story.afterChange('test', db, dir)
    const [a, b] = listTeams(db)
    const pa = listPlayers(db).find((p) => p.teamId === a!.id)!
    const pb = listPlayers(db).find((p) => p.teamId === b!.id && p.slotId === pa.slotId)!
    const category = (id: string) => {
      const page = pageByRef(db, 'player', id)!
      return revisionBody(db, page.id, page.currentRev!)!.body.match(/\[\[분류:(.+) 선수\]\]/)?.[1]
    }
    expect([category(pa.id), category(pb.id)]).toEqual([a!.shortName, b!.shortName])
    const trade = applyTrade(db, [
      { kind: 'player', playerId: pa.id, from: a!.id, to: b!.id },
      { kind: 'player', playerId: pb.id, from: b!.id, to: a!.id },
    ])
    story.afterChange('test', db, dir)
    expect([category(pa.id), category(pb.id)]).toEqual([b!.shortName, a!.shortName])
    db.prepare("UPDATE league_config SET json = json_set(json, '$.community.enabled', json('false'))").run()
    expect(loadConfig(db).config.community.enabled).toBe(false)
    vetoTrade(db, trade)
    story.afterChange('test', db, dir)
    expect([category(pa.id), category(pb.id)]).toEqual([a!.shortName, b!.shortName])
  })

  it("notes awards on the winners' pages: one job a look, later awards join it while it waits, a removed award leaves it", async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p1' })
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    let wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.instructions).toMatch(/^이번 일은 수상이다\./)
    expect(wiki.pages).toEqual([nameOf('p1'), nameOf('p7')])
    expect(wiki.context).toContain(`- 수상: 1주차 이주의 선수(주간 상) — ${nameOf('p1')} (${schoolOf('t1')})`)
    expect(wiki.context).toContain(`- 수상: MVP(시즌 상) — ${nameOf('p7')} (${schoolOf('t2')})`)

    // Typed in a moment later, while that job still waits: it joins it.
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 1, playerId: 'p13' })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.pages).toEqual([nameOf('p1'), nameOf('p7'), nameOf('p13')])
    expect(wiki.context).toContain(`- 수상: 올-리그 퍼스트 팀(시즌 상) — ${nameOf('p13')} (${schoolOf('t3')})`)

    // Taken back while its job waits: the award leaves the job, and its winner's page with it.
    removeAward(db, listAwards(db, currentSeason(db).id).find((a) => a.awardId === 'potw')!.id)
    expect(story.afterChange('test', db, dir)).toBe(0)
    wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.pages).toEqual([nameOf('p7'), nameOf('p13')])
    expect(wiki.context).not.toContain('이주의 선수(주간 상')
    expect(wiki.context).not.toContain('수상 취소')
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done'])

    // The MVP taken back once it's written: no awards job waits to tell of it (more may never come this season),
    // so the line gets a job of its own, with his page to take it out of.
    removeAward(db, listAwards(db, currentSeason(db).id).find((a) => a.awardId === 'mvp')!.id)
    expect(story.afterChange('test', db, dir)).toBe(1)
    expect(wikiJobs()).toHaveLength(2)
    wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.instructions).toMatch(/^이번 일은 수상이다\./)
    expect(wiki.pages).toEqual([nameOf('p7')])
    expect(wiki.context).toContain(`- 수상 취소(없던 일이 됨): MVP(시즌 상) — ${nameOf('p7')} (${schoolOf('t2')})`)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'done'])
    expect(flags()).toBe(0)
    // Told once: the job after that doesn't repeat it.
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p19' })
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs()[2]!).context).not.toContain('수상 취소')
  })

  it('tells the forum and the wiki a weekly award by its week and conference, never by its code', async () => {
    const { config } = loadConfig(db)
    config.awards.periodic[0]!.scope = 'conference'
    updateConfig(db, config)
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    // p13 plays for t3 (서); 이달의 선수 stays league-wide.
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p13' })
    giveAward(db, { awardId: 'potm', period: 'm2', teamRank: 1, playerId: 'p1' })
    story.afterChange('test', db, dir)
    const thread = jobs()
      .filter((j) => j.kind === 'event_thread')
      .map((j) => (JSON.parse(j.input) as { context: string }).context)
      .find((c) => c.includes('# 이번 소식\n- 수상:'))!
    expect(thread).toContain(`- 수상: 1주차 서 이주의 선수 — ${nameOf('p13')} (${schoolOf('t3')})`)
    expect(thread).toContain(`- 수상: 11월 이달의 선수 — ${nameOf('p1')} (${schoolOf('t1')})`)
    expect(thread).not.toContain('(w1)')
    const wiki = wikiInput(wikiJobs().at(-1)!)
    expect(wiki.context).toContain(`- 수상: 1주차 서 이주의 선수(주간 상) — ${nameOf('p13')} (${schoolOf('t3')})`)
    expect(wiki.context).toContain(`- 수상: 11월 이달의 선수(월간 상) — ${nameOf('p1')} (${schoolOf('t1')})`)
    // Taken back once written, the line names it the same way.
    await drain()
    removeAward(db, awardId('potw', 'w1'))
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs().at(-1)!).context).toContain(`- 수상 취소(없던 일이 됨): 1주차 서 이주의 선수(주간 상) — ${nameOf('p13')}`)
  })

  it('splits a burst of awards over more pages than one job edits', () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    for (let i = 0; i < 13; i++) giveAward(db, { awardId: 'potw', period: `w${i + 1}`, teamRank: 1, playerId: `p${i + 1}` })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => wikiInput(j).pages.length)).toEqual([12, 1])
  })

  it('notes draft swaps on the moved players’ and both schools’ pages, swaps over several looks in one job', async () => {
    toDraft()
    await drain()
    const first = swap()
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    let wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.instructions).toMatch(/^이번 일은 드래프트다\./)
    expect(wiki.pages).toEqual([first.target.name, first.own.name, schoolOf(first.by), schoolOf(first.from)])
    expect(wiki.context).toContain(`- ${first.target.name}: 드래프트 스왑으로 ${schoolOf(first.from)}에서 ${schoolOf(first.by)}로 이적`)
    expect(wiki.context).toContain(`- ${first.own.name}: 드래프트 스왑으로 ${schoolOf(first.by)}에서 ${schoolOf(first.from)}로 이적`)

    // The next pick a look later joins the job still waiting.
    const second = swap()
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.pages).toEqual(expect.arrayContaining([first.target.name, second.target.name, second.own.name, schoolOf(second.by), schoolOf(second.from)]))
    expect(wiki.context).toContain(`- ${second.target.name}: 드래프트 스왑으로 ${schoolOf(second.from)}에서 ${schoolOf(second.by)}로 이적`)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done'])
    // The first page's season paragraph tells of the move (the demo editor writes the first swap's first line there).
    const page = pageByRef(db, 'player', first.target.id)!
    expect(revisionBody(db, page.id, page.currentRev!)!.body).toContain(`=== 시즌 1 ===\n${first.target.name}: 드래프트 스왑으로`)
  })

  it('drops a vetoed swap from the job still waiting for it, and has a written one put right', async () => {
    toDraft()
    await drain()
    const a = swap()
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    // Vetoed before the editors got to it: nothing to write, nothing to undo.
    vetoDraftSwap(db, a.id)
    expect(story.afterChange('test', db, dir)).toBe(0)
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled'])
    await drain()

    const b = swap()
    story.afterChange('test', db, dir)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled', 'done'])
    // Vetoed once written: both players' pages and both schools' get the move undone.
    vetoDraftSwap(db, b.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(3)
    const wiki = wikiInput(wikiJobs()[2]!)
    expect(wiki.pages).toEqual([b.target.name, b.own.name, schoolOf(b.by), schoolOf(b.from)])
    expect(wiki.context).toContain(`- 드래프트 스왑 무효(되돌려짐): ${schoolOf(b.by)}의 ${b.target.name} 지명이 취소돼`)
  })

  it("notes a series won on both schools' pages and its standouts', with their series averages", async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    const [high1, high2] = listPlayers(db).filter((p) => p.teamId === 't1')
    const low1 = listPlayers(db).find((p) => p.teamId === 't2')!
    const low2 = listPlayers(db).filter((p) => p.teamId === 't2')[1]!
    // East's only round: t1 (1st) beats t2 4-2. Its best scorer averages 30, the loser's 25, his teammate 20; a fourth player is left out.
    playSeries('east:r1:0', [true, true, false, true, false, true], (game) => [
      { playerId: high1!.id, teamId: 't1', stats: { pts: [30, 28, 32, 26, 35, 29][game]!, reb: 8, ast: 5 } },
      { playerId: high2!.id, teamId: 't1', stats: { pts: 20, reb: 4, ast: 2 } },
      { playerId: low1.id, teamId: 't2', stats: { pts: 25, reb: 6, ast: 7 } },
      { playerId: low2.id, teamId: 't2', stats: { pts: 10, reb: 3, ast: 1 } },
    ])
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(1)
    const wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.instructions).toMatch(/^이번 일은 플레이오프다\./)
    // East's only round is its last: the conference final, and its title on the way to the finals.
    expect(wiki.context).toContain(`- 동 컨퍼런스 결승: ${schoolOf('t1')}가 ${schoolOf('t2')}를 4-2로 꺾음`)
    expect(wiki.context).toContain(`- 동 컨퍼런스 우승: ${schoolOf('t1')} (파이널 진출)`)
    // With the totals, so "6경기 180점" needs no arithmetic.
    expect(wiki.context).toContain(`시리즈 활약: ${high1!.name}(${schoolOf('t1')}) 6경기 평균 30.0점 8.0리바 5.0어시(총 180점 48리바 30어시)`)
    expect(wiki.context).toContain(`시리즈 활약: ${low1.name}(${schoolOf('t2')}) 6경기 평균 25.0점 6.0리바 7.0어시`)
    expect(wiki.context).toContain(`시리즈 활약: ${high2!.name}(${schoolOf('t1')}) 6경기 평균 20.0점 4.0리바 2.0어시`)
    expect(wiki.context).not.toContain(`시리즈 활약: ${low2.name}`)
    expect(wiki.pages).toEqual([high1!.name, low1.name, high2!.name, schoolOf('t1'), schoolOf('t2')])
    expect(wiki.context).not.toContain('- 우승:')
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done'])
    // The demo editors copy their facts: every number they use is there, so nothing is marked (nor would be redone).
    expect(flags()).toBe(0)
  })

  it('breaks a tie among standouts by points in all, then by name', () => {
    playRegularSeason()
    startPlayoffs(db)
    const player = (id: string) => listPlayers(db).find((p) => p.id === id)!
    // Five players average 20. p10 played one game fewer (60 in all, not 80); of the rest, p11's name comes last
    // (though its id sorts before p2's and p7's).
    const four = ['p1', 'p2', 'p7', 'p11'].map(player)
    const p10 = player('p10')
    playSeries('east:r1:0', [true, true, true, true], (game) => [
      ...four.map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 20 } })),
      ...(game < 3 ? [{ playerId: p10.id, teamId: p10.teamId, stats: { pts: 20 } }] : []),
    ])
    story.afterChange('test', db, dir)
    const stars = wikiInput(wikiJobs()[0]!).context.split('\n').filter((l) => l.includes('시리즈 활약'))
    const byName = four.map((p) => p.name).sort((x, y) => x.localeCompare(y, 'ko'))
    expect(byName.at(-1)).toBe(player('p11').name)
    expect(stars.map((l) => /활약: (\S+)\(/.exec(l)![1])).toEqual(byName.slice(0, 3))
  })

  it('writes the champion into the finals job, after one job for the series that landed together', async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    playSeries('east:r1:0', [true, true, true, true])
    playSeries('west:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(1)
    expect(wikiInput(wikiJobs()[0]!).pages).toEqual([schoolOf('t1'), schoolOf('t2'), schoolOf('t3'), schoolOf('t4')])
    await drain()
    // The finals: t1 over t3 in seven.
    playSeries('finals', [true, true, false, false, true, false, true])
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(2)
    const wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.pages).toEqual([schoolOf('t1'), schoolOf('t3')])
    expect(wiki.context).toContain(`- 파이널: ${schoolOf('t1')}가 ${schoolOf('t3')}를 4-3으로 꺾음`)
    expect(wiki.context).toContain(`- 우승: ${schoolOf('t1')} (준우승 ${schoolOf('t3')})`)
  })

  it('queues no wiki edits for awards, swaps or series with the community off', async () => {
    toDraft()
    await drain()
    const community = loadConfig(db).config.community
    story.saveSettings(db, { ...community, enabled: false })
    giveAward(db, { awardId: 'finals-mvp', period: '', teamRank: 1, playerId: 'p1' })
    swap()
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toEqual([])
  })

  it('queues no wiki edits for a series with the community off', () => {
    playRegularSeason()
    startPlayoffs(db)
    const community = loadConfig(db).config.community
    story.saveSettings(db, { ...community, enabled: false })
    playSeries('east:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toEqual([])
  })

  it('takes awards back out of a waiting job with the community off, and keeps a written one’s line for the next job', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' })
    story.afterChange('test', db, dir)
    await drain()
    giveAward(db, { awardId: 'potw', period: 'w2', teamRank: 1, playerId: 'p13' })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'queued'])
    // The community goes off: nothing new is written, but the job still waiting would run anyway.
    setCommunity(false)
    removeAward(db, awardId('potw', 'w2'))
    removeAward(db, awardId('mvp'))
    expect(story.afterChange('test', db, dir)).toBe(0)
    expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'cancelled'])
    // Back on, the next awards job hears the written MVP is gone, with his page; the other was never written.
    setCommunity(true)
    giveAward(db, { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p19' })
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs()[2]!)
    expect(wiki.pages).toEqual([nameOf('p19'), nameOf('p7')])
    expect(wiki.context).toContain(`- 수상 취소(없던 일이 됨): MVP(시즌 상) — ${nameOf('p7')} (${schoolOf('t2')})`)
    expect(wiki.context).not.toContain('2주차')
  })

  it('takes awards back out of a waiting job while Claude Code is unusable, and keeps a written one’s line', async () => {
    // A second service that finds Claude Code missing, looking at the same league.
    delete process.env.TWOK_FAKE_AI
    process.env.TWOK_NO_AI = '1'
    const off = new AiService()
    delete process.env.TWOK_NO_AI
    process.env.TWOK_FAKE_AI = '1'
    try {
      await off.refresh()
      expect(off.unavailable()).toBe(true)
      const offline = new StoryService(off)
      startSeason(db)
      story.afterChange('test', db, dir)
      await drain()
      giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' })
      story.afterChange('test', db, dir)
      await drain()
      giveAward(db, { awardId: 'potw', period: 'w2', teamRank: 1, playerId: 'p13' })
      story.afterChange('test', db, dir)
      expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'queued'])
      removeAward(db, awardId('potw', 'w2'))
      removeAward(db, awardId('mvp'))
      giveAward(db, { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p25' })
      expect(offline.afterChange('test', db, dir)).toBe(0)
      // Nothing new is queued, but nothing taken back is written either.
      expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'cancelled'])
    } finally {
      off.closeAll()
    }
    giveAward(db, { awardId: 'potw', period: 'w4', teamRank: 1, playerId: 'p19' })
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs()[2]!)
    expect(wiki.pages).toEqual([nameOf('p19'), nameOf('p7')])
    expect(wiki.context).toContain(`- 수상 취소(없던 일이 됨): MVP(시즌 상) — ${nameOf('p7')} (${schoolOf('t2')})`)
  })

  it('drops a vetoed swap from its waiting job with the community off, and has no veto written for a swap never written', async () => {
    toDraft()
    await drain()
    const a = swap()
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    setCommunity(false)
    vetoDraftSwap(db, a.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled'])
    // A swap made while the community was off was never written: vetoing it later writes nothing either.
    const b = swap()
    story.afterChange('test', db, dir)
    setCommunity(true)
    vetoDraftSwap(db, b.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled'])
  })

  it('writes an award for the school he won it for, with its fans, after a move since', async () => {
    toDraft()
    await drain()
    const s = swap()
    story.afterChange('test', db, dir)
    await drain()
    // The finals MVP is the player just swapped away from his school: he won it for that one.
    giveAward(db, { awardId: 'finals-mvp', period: '', teamRank: 1, playerId: s.target.id })
    story.afterChange('test', db, dir)
    let job = wikiJobs().at(-1)!
    let wiki = JSON.parse(job.input) as { context: string; pages: string[]; editors: string[] }
    expect(wiki.context).toContain(`- 수상: 파이널 MVP(시즌 상) — ${s.target.name} (${schoolOf(s.from)})`)
    const fans = listPersonas(db).filter((p) => wiki.editors.includes(p.id))
    expect(fans.filter((p) => p.teamId === s.from).length).toBeGreaterThanOrEqual(2)
    await drain()
    // Taken back once written: the line (a job of its own, with his page) keeps the school he won it for, and its fans.
    removeAward(db, awardId('finals-mvp'))
    story.afterChange('test', db, dir)
    job = wikiJobs().at(-1)!
    wiki = JSON.parse(job.input) as { context: string; pages: string[]; editors: string[] }
    expect(wiki.context).toContain(`- 수상 취소(없던 일이 됨): 파이널 MVP(시즌 상) — ${s.target.name} (${schoolOf(s.from)})`)
    expect(wiki.pages).toEqual([s.target.name])
    expect(listPersonas(db).filter((p) => wiki.editors.includes(p.id) && p.teamId === s.from).length).toBeGreaterThanOrEqual(2)
  })

  it('puts a written series result right when a corrected score flips it, the title too', async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    playSeries('east:r1:0', [true, true, true, true])
    playSeries('west:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    await drain()
    // The finals: t1 over t3 in seven, written.
    const finals = playSeries('finals', [true, true, true, false, false, false, true])
    story.afterChange('test', db, dir)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'done'])
    // Game seven went the other way: t3 takes the title.
    flipLastGame(finals.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(3)
    const wiki = wikiInput(wikiJobs()[2]!)
    expect(wiki.context).toContain(`- 정정: 파이널에서 ${schoolOf('t1')}가 ${schoolOf('t3')}를 꺾었다는 결과는 바뀌어 없던 일이 됐다(${schoolOf('t1')}의 우승도 없던 일)`)
    expect(wiki.context).toContain(`- 파이널: ${schoolOf('t3')}가 ${schoolOf('t1')}를 4-3으로 꺾음`)
    expect(wiki.context).toContain(`- 우승: ${schoolOf('t3')} (준우승 ${schoolOf('t1')})`)
    expect([...wiki.pages].sort()).toEqual([schoolOf('t1'), schoolOf('t3')].sort())
    expect(wiki.context.match(/- 정정:/g)).toHaveLength(1)
    await drain()
    expect(flags()).toBe(0)
    // Flipped back once that was written: t3's result is now the one put right.
    flipLastGame(finals.id)
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs()[3]!).context).toContain(`- 정정: 파이널에서 ${schoolOf('t3')}가 ${schoolOf('t1')}를 꺾었다는 결과는 바뀌어 없던 일이 됐다(${schoolOf('t3')}의 우승도 없던 일)`)
  })

  it("puts a written result right on its standouts' pages too, and says where a series not decided again stands", async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    const star = listPlayers(db).find((p) => p.teamId === 't1')!
    // East's only round, a sweep, written up with its standout.
    const east = playSeries('east:r1:0', [true, true, true, true], () => [{ playerId: star.id, teamId: 't1', stats: { pts: 30, reb: 5, ast: 5 } }])
    story.afterChange('test', db, dir)
    await drain()
    // Its last game went the other way: t1 leads 3-1, and the series goes on.
    flipLastGame(east.id)
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs().at(-1)!)
    expect(wiki.context).toContain(
      `- 정정: 동 컨퍼런스 결승에서 ${schoolOf('t1')}가 ${schoolOf('t2')}를 꺾었다는 결과는 바뀌어 없던 일이 됐다(${schoolOf('t1')}의 동 컨퍼런스 우승도 없던 일). 이 시리즈는 아직 끝나지 않았다(현재 ${schoolOf('t1')} 기준 3승 1패)`,
    )
    expect(wiki.pages).toEqual([star.name, schoolOf('t1'), schoolOf('t2')])
    await drain()
    expect(flags()).toBe(0)
  })

  it('puts a written series result right once the community is back on, when it changed while it was off', async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    playSeries('east:r1:0', [true, true, true, true])
    playSeries('west:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    await drain()
    const finals = playSeries('finals', [true, true, true, false, false, false, true])
    story.afterChange('test', db, dir)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done', 'done'])
    // Game seven went the other way while the community was off: nothing could be queued then.
    setCommunity(false)
    flipLastGame(finals.id)
    expect(story.afterChange('test', db, dir)).toBe(0)
    expect(wikiJobs()).toHaveLength(2)
    // Back on, the first look sends out the correction that waited, with the new result.
    setCommunity(true)
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(3)
    const wiki = wikiInput(wikiJobs()[2]!)
    expect(wiki.context).toContain(`- 정정: 파이널에서 ${schoolOf('t1')}가 ${schoolOf('t3')}를 꺾었다는 결과는 바뀌어 없던 일이 됐다(${schoolOf('t1')}의 우승도 없던 일)`)
    expect(wiki.context).toContain(`- 우승: ${schoolOf('t3')} (준우승 ${schoolOf('t1')})`)
    await drain()
    expect(flags()).toBe(0)
    // Sent once.
    news()
    expect(wikiJobs()).toHaveLength(3)
  })

  it('puts a written series result right once Claude Code works again', async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    playSeries('east:r1:0', [true, true, true, true])
    playSeries('west:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    await drain()
    const finals = playSeries('finals', [true, true, true, false, false, false, true])
    story.afterChange('test', db, dir)
    await drain()
    // A look while Claude Code is missing queues nothing.
    delete process.env.TWOK_FAKE_AI
    process.env.TWOK_NO_AI = '1'
    const off = new AiService()
    delete process.env.TWOK_NO_AI
    process.env.TWOK_FAKE_AI = '1'
    try {
      await off.refresh()
      flipLastGame(finals.id)
      new StoryService(off).afterChange('test', db, dir)
      expect(wikiJobs()).toHaveLength(2)
    } finally {
      off.closeAll()
    }
    // The next look that may queue jobs sends the correction.
    news()
    expect(wikiJobs()).toHaveLength(3)
    expect(wikiInput(wikiJobs()[2]!).context).toContain(`- 정정: 파이널에서 ${schoolOf('t1')}가 ${schoolOf('t3')}를 꺾었다는 결과는`)
  })

  it('puts a written swap right once the community is back on, when it was vetoed while it was off', async () => {
    toDraft()
    await drain()
    const b = swap()
    story.afterChange('test', db, dir)
    await drain()
    expect(wikiJobs().map((j) => j.status)).toEqual(['done'])
    setCommunity(false)
    vetoDraftSwap(db, b.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(1)
    setCommunity(true)
    story.afterChange('test', db, dir)
    expect(wikiJobs()).toHaveLength(2)
    const wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.pages).toEqual([b.target.name, b.own.name, schoolOf(b.by), schoolOf(b.from)])
    expect(wiki.context).toContain(`- 드래프트 스왑 무효(되돌려짐): ${schoolOf(b.by)}의 ${b.target.name} 지명이 취소돼`)
  })

  it('runs a number-check retry of a playoffs job ahead of the correction queued while it ran', async () => {
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    playSeries('east:r1:0', [true, true, true, true])
    playSeries('west:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    await drain()
    const finals = playSeries('finals', [true, true, true, false, false, false, true])
    story.afterChange('test', db, dir)
    const first = db.prepare("SELECT id, input FROM jobs WHERE kind = 'wiki_edits' AND status = 'queued'").get() as { id: number; input: string }
    // It starts running; meanwhile game seven is corrected and t3 takes the title: a correction is queued.
    db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), first.id)
    flipLastGame(finals.id)
    story.afterChange('test', db, dir)
    // The run ends with a number its facts don't hold: the retry is queued as the app queues it.
    const input = JSON.parse(first.input) as WikiEditInput
    const kind = wikiEditKind(db, () => null, { requeue: (retry) => void ai.queueFor('test', db, dir).enqueue(WIKI_EDITS, retry, WIKI_RETRY_PRIORITY) })
    const edit = { page: input.pages[0]!, section: input.season!, mode: 'append' as const, text: '평균 77.7점.', summary: '편집', editor: input.editors[0]! }
    kind.accept!({ edits: [edit], disputes: [] }, { id: first.id, input } as unknown as JobRow)
    db.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), first.id)
    // The retry keeps its place: it runs before the correction, which has the last word.
    const order = (db.prepare("SELECT input FROM jobs WHERE kind = 'wiki_edits' AND status = 'queued' ORDER BY priority DESC, id").all() as { input: string }[]).map(
      (j) => JSON.parse(j.input) as WikiEditInput,
    )
    expect(order.map((i) => i.numberRetry !== undefined)).toEqual([true, false])
    expect(order[1]!.context).toContain(`- 정정: 파이널에서 ${schoolOf('t1')}가 ${schoolOf('t3')}를 꺾었다는 결과는`)
    await drain()
    // What was written last is t3's title, so a later flip back puts that right.
    expect(writtenItem(db, currentSeason(db).id, `series:${finals.id}`)?.item.result?.winner).toBe('t3')
    flipLastGame(finals.id)
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs().at(-1)!).context).toContain(`- 정정: 파이널에서 ${schoolOf('t3')}가 ${schoolOf('t1')}를 꺾었다는 결과는`)
  })

  it('drops an award taken back while its job ran from that job once it is back in the queue', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' })
    story.afterChange('test', db, dir)
    // It starts running, and the award is taken back meanwhile: the line gets a job of its own.
    db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE kind = 'wiki_edits'").run(new Date().toISOString())
    removeAward(db, awardId('mvp'))
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['running', 'queued'])
    // It goes back to the queue as it was (a usage limit, the app closed, a failed first try). The next look takes
    // the MVP out of it rather than have it written beside the line taking it back.
    db.prepare("UPDATE jobs SET status = 'queued' WHERE kind = 'wiki_edits' AND status = 'running'").run()
    giveAward(db, { awardId: 'potw', period: 'w2', teamRank: 1, playerId: 'p13' })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled', 'queued'])
    const wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.context).not.toContain('- 수상: MVP')
    expect(wiki.context).toContain(`- 수상 취소(없던 일이 됨): MVP(시즌 상) — ${nameOf('p7')}`)
    expect(wiki.context).toContain(`- 수상: 2주차 이주의 선수(주간 상) — ${nameOf('p13')}`)
  })

  it("keeps a waiting job's age when something only leaves it", () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p1' })
    giveAward(db, { awardId: 'potw', period: 'w2', teamRank: 1, playerId: 'p7' })
    story.afterChange('test', db, dir)
    const age = () => (db.prepare("SELECT created_at AS at FROM jobs WHERE kind = 'wiki_edits'").get() as { at: string }).at
    const then = new Date(Date.now() - 3600_000).toISOString()
    db.prepare("UPDATE jobs SET created_at = ? WHERE kind = 'wiki_edits'").run(then)
    // Taking an award out doesn't give it another day to run.
    removeAward(db, awardId('potw', 'w1'))
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs()[0]!).pages).toEqual([nameOf('p7')])
    expect(age()).toBe(then)
    // News joining it does.
    giveAward(db, { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p13' })
    story.afterChange('test', db, dir)
    expect(age() > then).toBe(true)
  })

  it('crowns the last round of a one-conference bracket with no final, as the 플레이오프 screen does', async () => {
    db.prepare("UPDATE league_config SET json = json_set(json, '$.structure', json(?), '$.season.playoffs', json(?))").run(
      JSON.stringify({ conferences: [{ id: 'east', name: '동' }], divisions: ['n', 's', 'e', 'w'].map((id) => ({ id, name: id, conferenceId: 'east' })) }),
      JSON.stringify({ enabled: true, bracket: 'conference', directSeeds: 4, playIn: { enabled: false, format: 'nba', bestOf: 1 }, seriesBestOf: 3, finals: { kind: 'none', bestOf: 3 } }),
    )
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    const a = playSeries('east:r1:0', [true, true])
    playSeries('east:r1:1', [true, true])
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs()[0]!).context).toContain(`- 동 컨퍼런스 플레이오프 1라운드: ${schoolOf(a.high!)}가 ${schoolOf(a.low!)}를 2-0으로 꺾음`)
    expect(leagueChampion(playoffsView(db).series)).toBeNull()
    await drain()
    const last = playSeries('east:r2:0', [true, true])
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.context).toContain(`- 동 컨퍼런스 결승: ${schoolOf(last.high!)}가 ${schoolOf(last.low!)}를 2-0으로 꺾음`)
    expect(wiki.context).toContain(`- 우승: ${schoolOf(last.high!)} (준우승 ${schoolOf(last.low!)})`)
    // The screen's badge names the same champion.
    expect(leagueChampion(playoffsView(db).series)).toBe(last.high)
    await drain()
    expect(flags()).toBe(0)
  })

  it('drops a series from its waiting job when its result changes, and writes no correction for what was never written', () => {
    playRegularSeason()
    startPlayoffs(db)
    const east = playSeries('east:r1:0', [true, true, true, false, false, false, true])
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    setCommunity(false)
    flipLastGame(east.id)
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['cancelled'])
    // Flipped back with the community on: the result is news, and nothing written needs putting right.
    setCommunity(true)
    flipLastGame(east.id)
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.context).toContain(`- 동 컨퍼런스 결승: ${schoolOf('t1')}가 ${schoolOf('t2')}를 4-3으로 꺾음`)
    expect(wiki.context).not.toContain('정정')
  })

  it('names play-in games by their place, gives a single game its score, and crowns the last round with no final', async () => {
    db.prepare("UPDATE league_config SET json = json_set(json, '$.season.playoffs', json(?))").run(
      JSON.stringify({ enabled: true, bracket: 'league', directSeeds: 2, playIn: { enabled: true, format: 'nba', bestOf: 1 }, seriesBestOf: 3, finals: { kind: 'none', bestOf: 3 } }),
    )
    playRegularSeason()
    startPlayoffs(db)
    await drain()
    const s = (n: number) => schoolOf(`t${n}`)
    const ace = listPlayers(db).find((p) => p.teamId === 't4')!
    // 3rd v 4th: the 4th wins, and the 3rd plays again. 5th v 6th: the 6th is out.
    playSeries('league:pi:a', [false], () => [{ playerId: ace.id, teamId: 't4', stats: { pts: 31, reb: 7, ast: 4 } }])
    playSeries('league:pi:b', [true])
    story.afterChange('test', db, dir)
    let wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.context).toContain(`- 플레이-인 3·4위전: ${s(4)}가 ${s(3)}를 100-90으로 꺾음 — ${s(4)}는 3번 시드로 플레이오프 진출, ${s(3)}는 탈락하지 않고 4번 시드 결정전으로`)
    expect(wiki.context).toContain(`- 플레이-인 5·6위전: ${s(5)}가 ${s(6)}를 100-90으로 꺾음 — ${s(5)}는 4번 시드 결정전으로, ${s(6)}는 탈락`)
    expect(wiki.context).toContain(`- 플레이-인 3·4위전 활약: ${ace.name}(${s(4)}) 31점 7리바 4어시`)
    expect(wiki.context).not.toContain('1-0')
    expect(wiki.context).not.toContain('1경기 평균')
    await drain()
    playSeries('league:pi:c', [true])
    story.afterChange('test', db, dir)
    wiki = wikiInput(wikiJobs()[1]!)
    expect(wiki.context).toContain(`- 플레이-인 4번 시드 결정전: ${s(3)}가 ${s(5)}를 100-90으로 꺾음 — ${s(3)}는 4번 시드로 플레이오프 진출, ${s(5)}는 탈락`)
    await drain()
    playSeries('league:r1:0', [true, true])
    playSeries('league:r1:1', [true, true])
    story.afterChange('test', db, dir)
    expect(wikiInput(wikiJobs()[2]!).context).toContain(`- 플레이오프 1라운드: ${s(1)}가 ${s(3)}를 2-0으로 꺾음`)
    await drain()
    // With no final series, the bracket's last round is the final: its winner is the champion.
    playSeries('league:r2:0', [true, true])
    story.afterChange('test', db, dir)
    wiki = wikiInput(wikiJobs()[3]!)
    expect(wiki.context).toContain(`- 파이널: ${s(1)}가 ${s(2)}를 2-0으로 꺾음`)
    expect(wiki.context).toContain(`- 우승: ${s(1)} (준우승 ${s(2)})`)
    await drain()
    expect(flags()).toBe(0)
  })

  it('gives each conference its own title when no final follows', () => {
    db.prepare("UPDATE league_config SET json = json_set(json, '$.season.playoffs.finals.kind', 'none')").run()
    playRegularSeason()
    startPlayoffs(db)
    playSeries('east:r1:0', [true, true, true, true])
    story.afterChange('test', db, dir)
    const wiki = wikiInput(wikiJobs()[0]!)
    expect(wiki.context).toContain(`- 동 컨퍼런스 결승: ${schoolOf('t1')}가 ${schoolOf('t2')}를 4-0으로 꺾음`)
    expect(wiki.context).toContain(`- 동 컨퍼런스 우승: ${schoolOf('t1')} (준우승 ${schoolOf('t2')})`)
    expect(wiki.context).not.toContain('- 우승:')
  })

  it('starts no edit war from an awards, draft or playoffs job', () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    new WikiService().ensure(db, dir, true)
    const name = nameOf('p1')
    const wars: unknown[] = []
    const kind = wikiEditKind(db, () => null, { contested: (edits) => wars.push(edits) })
    const run = (occasion?: object) => {
      const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_edits', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
      const input = { pages: [name], editors: ['f001', 'f002'], season: '시즌 1', context: '', instructions: '', ...(occasion ? { occasion } : {}) }
      const edit = { page: name, section: '시즌 1', mode: 'append' as const, text: '새 소식.', summary: '편집', editor: 'f001' }
      kind.accept!({ edits: [edit], disputes: [{ page: name, section: '시즌 1', challenger: 'f002', heat: 5, why: '편향 서술' }] }, { id, input } as unknown as JobRow)
    }
    run({ kind: 'playoffs', seasonId: 1, items: [], notes: [] })
    expect(wars).toEqual([])
    // A round's job may still start one.
    run()
    expect(wars).toHaveLength(1)
  })

  it('lets every page of a big job (an awards burst) have its two edits', () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    new WikiService().ensure(db, dir, true)
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map(nameOf)
    const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_edits', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    const edits = names.flatMap((page) => ['별명', '여담'].map((section) => ({ page, section, mode: 'append' as const, text: '덧붙임.', summary: '편집', editor: 'f001' })))
    const input = { pages: names, editors: ['f001'], context: '', instructions: '' }
    wikiEditKind(db).accept!({ edits, disputes: [] }, { id, input } as unknown as JobRow)
    expect((db.prepare('SELECT COUNT(*) AS n FROM wiki_revisions WHERE job_id = ?').get(id) as { n: number }).n).toBe(14)
  })

  it('keeps a waiting retry a retry when more awards join it', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' })
    story.afterChange('test', db, dir)
    // The job waiting is the number check's retry (of job 999).
    db.prepare("UPDATE jobs SET input = json_set(input, '$.numberRetry', json('[\"41\"]'), '$.retryOf', 999) WHERE kind = 'wiki_edits'").run()
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 1, playerId: 'p13' })
    story.afterChange('test', db, dir)
    expect(wikiJobs().map((j) => j.status)).toEqual(['queued'])
    const input = JSON.parse(wikiJobs()[0]!.input) as { pages: string[]; numberRetry?: string[]; retryOf?: number }
    expect(input.pages).toEqual([nameOf('p7'), nameOf('p13')])
    expect(input).toMatchObject({ numberRetry: ['41'], retryOf: 999 })
  })

  it('posts a correction notice when a score is fixed after its thread is up', async () => {
    startSeason(db)
    const game = listGames(db, 1)[0]!
    recordScore(db, { gameId: game.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    recordScore(db, { gameId: game.id, homeScore: 83, awayScore: 77, lines: null })
    expect(story.afterChange('test', db, dir)).toBe(1)
    const fix = jobs().at(-1)!
    expect(fix.kind).toBe('event_thread')
    expect(fix.input).toContain('점수 정정')
    expect(fix.input).toContain('81 : 77')
    await drain()
    // Box lines fixed with the score unchanged aren't news; saving it unchanged isn't even a correction.
    const player = sampleSetup().players.find((p) => p.teamId === game.home)!
    const lines = [{ playerId: player.id, teamId: game.home, stats: { pts: 20 } }]
    recordScore(db, { gameId: game.id, homeScore: 83, awayScore: 77, lines })
    expect(story.afterChange('test', db, dir)).toBe(0)
    recordScore(db, { gameId: game.id, homeScore: 83, awayScore: 77, lines })
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'game_corrected'").get()).toEqual({ n: 2 })
  })

  it('takes a game back on 기록 취소: its thread still waiting goes, one already up gets a notice', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const [first, second] = listGames(db, 1)
    recordScore(db, { gameId: first!.id, homeScore: 81, awayScore: 77, lines: null })
    recordScore(db, { gameId: second!.id, homeScore: 70, awayScore: 75, lines: null })
    story.afterChange('test', db, dir)
    // The first game's thread is being written; the second's waits. Nobody saw that one, so it just goes.
    unrecordGame(db, second!.id)
    story.afterChange('test', db, dir)
    const threadsOf = (id: number) => jobs().filter((j) => j.kind === 'post_game_thread' && (JSON.parse(j.input) as { gameId?: number }).gameId === id)
    expect(threadsOf(second!.id).map((j) => j.status)).toEqual(['cancelled'])
    expect(jobs().some((j) => j.input.includes('기록 취소'))).toBe(false)
    await drain()
    // The first one's thread is up: taking that game back is news.
    unrecordGame(db, first!.id)
    story.afterChange('test', db, dir)
    // A thread about the taking back (others may mention it among recent titles).
    const notices = () => jobs().filter((j) => j.kind === 'event_thread' && (JSON.parse(j.input) as { context: string }).context.includes('# 이번 소식\n- 기록 취소:'))
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.input).toContain('81 : 77')
    await drain()
    // Recorded again, it gets a thread of its own; recorded and taken back within one look, nothing at all.
    recordScore(db, { gameId: first!.id, homeScore: 90, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    expect(threadsOf(first!.id)).toHaveLength(2)
    await drain()
    recordScore(db, { gameId: second!.id, homeScore: 60, awayScore: 75, lines: null })
    unrecordGame(db, second!.id)
    story.afterChange('test', db, dir)
    expect(threadsOf(second!.id)).toHaveLength(1)
    expect(notices()).toHaveLength(1)
  })

  it('drops a thread being written when its game is taken back or corrected, and writes a corrected one again', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const [first, second] = listGames(db, 1)
    const threadJobs = (id: number) => jobs().filter((j) => j.kind === 'post_game_thread' && (JSON.parse(j.input) as { gameId?: number }).gameId === id)
    const posted = (id: number) => (db.prepare("SELECT title FROM posts WHERE game_id = ? AND kind = 'thread'").all(id) as { title: string }[]).map((p) => p.title)
    // 기록 취소 while its thread is being written: nothing goes up, so there's nothing to take back.
    recordScore(db, { gameId: first!.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    expect(threadJobs(first!.id).map((j) => j.status)).toEqual(['running'])
    unrecordGame(db, first!.id)
    story.afterChange('test', db, dir)
    await drain()
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE game_id = ?').get(first!.id)).toEqual({ n: 0 })
    expect(jobs().some((j) => j.kind === 'event_thread' && j.input.includes('기록 취소:'))).toBe(false)
    // Recorded again: one thread, with the new score.
    recordScore(db, { gameId: first!.id, homeScore: 70, awayScore: 90, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    expect(posted(first!.id)).toHaveLength(1)
    expect(posted(first!.id)[0]).toContain('70 : 90')

    // A score corrected while its thread is being written: that answer is dropped, and the thread is written again.
    recordScore(db, { gameId: second!.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    expect(threadJobs(second!.id).map((j) => j.status)).toEqual(['running'])
    recordScore(db, { gameId: second!.id, homeScore: 77, awayScore: 81, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    expect(threadJobs(second!.id)).toHaveLength(2)
    expect(posted(second!.id)).toHaveLength(1)
    expect(posted(second!.id)[0]).toContain('77 : 81')
    expect(jobs().some((j) => j.kind === 'event_thread' && j.input.includes('점수 정정'))).toBe(false)
  })

  it('refuses 다시 시도 of a game thread whose game was taken back or corrected since, or whose moment has passed', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const [first, second, third] = listGames(db, 1)
    const failThread = (gameId: number) => {
      const { id } = db.prepare("SELECT id FROM jobs WHERE kind = 'post_game_thread' ORDER BY id DESC LIMIT 1").get() as { id: number }
      expect((JSON.parse((db.prepare('SELECT input FROM jobs WHERE id = ?').get(id) as { input: string }).input) as { gameId: number }).gameId).toBe(gameId)
      // As if it had timed out: nothing posted for the game.
      db.prepare('UPDATE posts SET game_id = NULL WHERE game_id = ?').run(gameId)
      db.prepare("UPDATE jobs SET status = 'failed', error = 'timed out', error_kind = 'timeout', output = NULL WHERE id = ?").run(id)
      return id
    }
    const refusal = (id: number) => {
      try {
        ai.retry('test', db, dir, id)
        return null
      } catch (e) {
        return (e as { issues?: { code: string }[] }).issues?.[0]?.code ?? String(e)
      }
    }
    recordScore(db, { gameId: first!.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    const taken = failThread(first!.id)
    unrecordGame(db, first!.id)
    story.afterChange('test', db, dir)
    expect(refusal(taken)).toBe('job-not-wanted')

    recordScore(db, { gameId: second!.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    const corrected = failThread(second!.id)
    recordScore(db, { gameId: second!.id, homeScore: 83, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    expect(refusal(corrected)).toBe('job-not-wanted')

    // Queued two days ago, and retried once since (that failed too): too late, counted from the first job, not the retry.
    recordScore(db, { gameId: third!.id, homeScore: 81, awayScore: 77, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    const old = failThread(third!.id)
    const { input } = db.prepare('SELECT input FROM jobs WHERE id = ?').get(old) as { input: string }
    const retried = Number(
      db
        .prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('post_game_thread', 'failed', 30, ?, ?)")
        .run(JSON.stringify({ ...(JSON.parse(input) as object), manualRetryOf: old }), new Date().toISOString()).lastInsertRowid,
    )
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString(), old)
    expect(refusal(retried)).toBe('job-not-wanted')
    expect(refusal(old)).toBe('job-not-wanted')
  })

  it('has 다시 시도 of an awards, draft or playoffs wiki job refused once news of its kind was taken back', () => {
    const kind = wikiEditKind(db)
    const job = { createdAt: new Date().toISOString() } as JobRow
    const asOfEvent = lastEventId(db)
    const retry = (k: 'award' | 'draft' | 'playoffs') =>
      ({ occasion: { kind: k, seasonId: 1, items: [], notes: [] }, asOfEvent, manualRetryOf: 1 }) as unknown as WikiEditInput
    expect(kind.stillWanted!(retry('award'), job)).toBe(true)
    // A trade's veto isn't a draft swap's.
    appendEvent(db, 'move_vetoed', { kind: 'trade', refId: 1 }, 1)
    expect(kind.stillWanted!(retry('draft'), job)).toBe(true)
    appendEvent(db, 'award_removed', { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' }, 1)
    expect(kind.stillWanted!(retry('award'), job)).toBe(false)
    expect(kind.stillWanted!(retry('playoffs'), job)).toBe(true)
    // A job still waiting is rewritten when news is taken back (and loses the retry mark), so it runs.
    expect(kind.stillWanted!({ ...retry('award'), manualRetryOf: undefined } as WikiEditInput, job)).toBe(true)
    appendEvent(db, 'move_vetoed', { kind: 'draft-swap', refId: 1 }, 1)
    expect(kind.stillWanted!(retry('draft'), job)).toBe(false)
  })

  it('prunes old story job contexts and keeps a few notes per persona', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const fan = (db.prepare("SELECT id FROM personas WHERE kind = 'fan' LIMIT 1").get() as { id: string }).id
    const add = db.prepare('INSERT INTO persona_memory (persona_id, note, created_at) VALUES (?, ?, ?)')
    for (let i = 0; i < 12; i++) add.run(fan, `메모 ${i}`, new Date().toISOString())
    story.prune(db, dir, Date.now() + 4 * 86_400_000)
    expect(jobs().every((j) => j.input === '{}')).toBe(true)
    const notes = db.prepare('SELECT note FROM persona_memory WHERE persona_id = ? ORDER BY id DESC').all(fan) as { note: string }[]
    expect(notes).toHaveLength(8)
    expect(notes[0]!.note).toBe('메모 11')
  })

  it('saves settings: boards renamed but not added, your nick everywhere, taken nicks refused', () => {
    story.front(db, dir)
    const { community } = loadConfig(db).config
    const renamed = { ...community, myNick: '테스트닉네임', boards: community.boards.map((b) => (b.id === 'free' ? { ...b, name: '아무말' } : b)) }
    story.saveSettings(db, renamed)
    expect(loadConfig(db).config.community.boards.find((b) => b.id === 'free')!.name).toBe('아무말')
    expect(db.prepare("SELECT nick FROM personas WHERE id = 'me'").get()).toEqual({ nick: '테스트닉네임' })
    expect(() => story.saveSettings(db, { ...renamed, boards: [...renamed.boards, { id: 'extra', name: '새 판', role: 'free' }] })).toThrow(/boards-fixed/)
    const taken = (db.prepare("SELECT nick FROM personas WHERE kind = 'fan' LIMIT 1").get() as { nick: string }).nick
    expect(() => story.saveSettings(db, { ...renamed, myNick: taken })).toThrow(/nick-taken/)
  })

  it('lists the lore folder with links and missing players', () => {
    const view = new LoreService(dir).index(db, dir)
    expect(view.files).toHaveLength(2)
    expect(view.files.every((f) => f.linkedTo !== null)).toBe(true)
    expect(view.files.find((f) => f.kind === 'player')!.sizes.secret).toBe(SECRET.length)
    expect(view.missing.length).toBe(sampleSetup().players.length - 1)
  })
})
