import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { defaultCardSwap } from '@shared/config/defaults'
import type { EventPayloads } from '@shared/events'
import { scoreDeal } from '@core/market'
import { openDb, type Db } from '@data/db'
import { createNegotiation, getNegotiation, insertWindow, updateNegotiation, windowAfterRound } from '@data/gm'
import { currentSeason, listEvents, listPlayers, loadConfig, seedLeague, updateConfig } from '@data/league'
import { listChecklist, listTrades } from '@data/moves'
import { listGames, recordScore, setPhase, startSeason } from '@data/season'
import { describeEvent, readLeague } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { gmDemo, gmKinds, intentInput, readMarket, resolvePlayer, respondInput, settleDeal, tradeIsBlockbuster, type GmHooks } from '@sim/gm'
import { AiService } from './ai'
import { GmService } from './gm'
import { syncLoreFolder } from './lore'
import { StoryService } from './story'

const SECRET = '사실은 이 학교를 떠날 생각이다'

let dir: string
let db: Db
let ai: AiService
let gm: GmService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-gm-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  // One GM with a persona and a secret no job may see.
  mkdirSync(join(dir, 'lore', 'teams', '가람고'), { recursive: true })
  writeFileSync(
    join(dir, 'lore', 'teams', '가람고', '가람고 단장.md'),
    `---\nid: 가람고 단장\nname: 김단장\nteam: 가람고\nphilosophy: win-now\ntraits: { star_chasing: 5, risk: 5 }\nnegotiation: hardball\n---\n\n## 공개\n말이 짧다.\n\n## 비밀\n${SECRET}\n`,
  )
  ai = new AiService()
  const hooks = (slug: string, d: Db, f: string): GmHooks => ({
    queue: (kind, input, priority) => void ai.queueFor(slug, d, f).enqueue(kind, input, priority),
    changed: () => {
      syncLoreFolder(d, f)
      story.afterChange(slug, d, f)
    },
  })
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f, slug) => gmKinds(d, f, hooks(slug, d, f)), gmDemo)
  await ai.refresh()
  gm = new GmService(ai, hooks)
  story = new StoryService(ai, { onRound: (slug, d, f, season, round) => gm.onRound(slug, d, f, season, round) })
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = async () => {
  for (let i = 0; i < 5; i++) {
    await ai.queueFor('test', db, dir).kick()
    await new Promise((r) => setImmediate(r))
  }
}
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const setGm = (change: Partial<ReturnType<typeof loadConfig>['config']['gm']>) => {
  const { config } = loadConfig(db)
  updateConfig(db, { ...config, gm: { ...config.gm, ...change } })
}

describe('a trade window (demo GMs)', () => {
  it('motivated GMs offer, receivers answer, and deals go through the League engine', async () => {
    const opened = gm.openWindow('test', db, dir, 'manual', null)
    expect(opened.gms).toBeGreaterThan(0)
    expect(gm.status('test', db, dir).open?.id).toBe(opened.windowId)
    for (const j of jobs('gm_intent')) {
      expect(j.input).not.toContain(SECRET)
      // The GM with a lore file gets its persona (공개), never its 비밀.
      if (j.input.includes('김단장')) expect(j.input).toContain('말이 짧다')
    }
    await drain()
    const [w] = gm.windows(db)
    expect(w!.status).toBe('closed')
    const accepted = w!.negotiations.filter((n) => n.status === 'accepted')
    expect(accepted.length).toBeGreaterThan(0)
    for (const n of w!.negotiations) {
      expect(n.steps[0]!.action).toBe('offer')
      expect(n.steps[0]!.note).not.toBe('')
    }
    for (const j of jobs('gm_respond')) expect(j.input).not.toContain(SECRET)
    // The trades are the League engine's: on the 2K checklist, vetoable, with their thread queued.
    const trades = listTrades(db, currentSeason(db).id)
    expect(trades.filter((t) => t.source === 'gm')).toHaveLength(accepted.length)
    expect(listChecklist(db).length).toBe(accepted.length)
    expect(accepted.every((n) => n.vetoable)).toBe(true)
    expect(listEvents(db, 'trade_window_closed')).toHaveLength(1)
    expect(jobs('event_thread').length).toBeGreaterThan(0)
    // No team ends up in two deals in one window.
    const teams = accepted.flatMap((n) => [n.fromTeam, n.toTeam])
    expect(new Set(teams).size).toBe(teams.length)
    expect(gm.status('test', db, dir).open).toBeNull()
  })

  it('with autonomy set to propose, agreed deals wait for you', async () => {
    setGm({ autonomy: 'propose' })
    gm.openWindow('test', db, dir, 'manual', null)
    await drain()
    const agreed = gm.windows(db)[0]!.negotiations.filter((n) => n.status === 'agreed')
    expect(agreed.length).toBeGreaterThan(0)
    expect(listTrades(db, currentSeason(db).id)).toHaveLength(0)
    expect(gm.status('test', db, dir).agreed).toBe(agreed.length)
    expect(gm.approve('test', db, dir, agreed[0]!.id)).toEqual({ status: 'accepted' })
    expect(listTrades(db, currentSeason(db).id)).toHaveLength(1)
    if (agreed[1]) {
      gm.decline(db, agreed[1].id)
      expect(gm.windows(db)[0]!.negotiations.find((n) => n.id === agreed[1]!.id)!.status).toBe('declined')
    }
  })

  it('opens a window after every N completed rounds', async () => {
    setGm({ tradeWindowEveryRounds: 1 })
    startSeason(db)
    story.afterChange('test', db, dir)
    for (const g of listGames(db, currentSeason(db).id).filter((x) => x.stage === 'regular' && x.round === 1)) {
      const lines = listPlayers(db)
        .filter((p) => p.teamId === g.home || p.teamId === g.away)
        .map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 10 } }))
      recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
    }
    story.afterChange('test', db, dir)
    expect(windowAfterRound(db, currentSeason(db).id, 1)).toBe(true)
    expect(jobs('gm_intent').length).toBeGreaterThan(0)
  })

  it('drops a window’s work when trades close, and the window closes', async () => {
    gm.openWindow('test', db, dir, 'manual', null)
    // Trades are only allowed in preseason and regular season here.
    setPhase(db, currentSeason(db), 'offseason')
    await drain()
    expect(jobs('gm_intent').every((j) => j.status === 'cancelled')).toBe(true)
    expect(gm.status('test', db, dir).open).toBeNull()
    expect(() => gm.openWindow('test', db, dir, 'manual', null)).toThrow()
  })

  it('never opens a window in the playoffs, even when the league ticked them as a trade phase', () => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, trades: { ...config.trades, phases: ['preseason', 'regular', 'playoffs'] } })
    setPhase(db, currentSeason(db), 'playoffs')
    expect(gm.status('test', db, dir).blocked).toBe('phase')
    expect(() => gm.openWindow('test', db, dir, 'manual', null)).toThrow()
  })

  it('tells the forum a GM deal was lopsided, and leaked talks are rumors', () => {
    const league = readLeague(db, dir)
    const players = listPlayers(db)
    const trade = describeEvent(league, {
      id: 1,
      type: 'trade_applied',
      seasonId: 1,
      createdAt: '',
      payload: { tradeId: 1, teams: ['t1', 't2'], players: [players[0]!.id], cards: [], negotiationId: 3, valueGap: 22, lopsided: true },
    } as never)
    expect(trade?.text).toContain('사기 트레이드')
    const talks = describeEvent(league, { id: 2, type: 'trade_talks', seasonId: 1, createdAt: '', payload: { negotiationId: 3, teams: ['t1', 't2'], players: [] } } as never)
    expect(talks?.text).toContain('찌라시')
    const quiet = describeEvent(league, { id: 3, type: 'trade_window_closed', seasonId: 1, createdAt: '', payload: { windowId: 1, trades: 0, agreed: 0, talks: 0 } } as never)
    expect(quiet).toBeNull()
    const waiting = describeEvent(league, { id: 4, type: 'trade_window_closed', seasonId: 1, createdAt: '', payload: { windowId: 1, trades: 1, agreed: 2, talks: 3 } } as never)
    expect(waiting?.text).toContain('승인 대기 2건')
    expect(waiting?.text).not.toContain('결렬')
  })
})

describe('what the review found', () => {
  it('opens no window at all when no GM has anything worth offering', () => {
    // One AI team left: it has nobody to trade with.
    db.prepare("UPDATE teams SET control = 'user' WHERE id <> 't1'").run()
    expect(gm.openWindow('test', db, dir, 'manual', null)).toEqual({ windowId: null, gms: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_windows').get()).toEqual({ n: 0 })
    expect(listEvents(db, 'trade_window_opened')).toHaveLength(0)
  })

  it('a window stuck open doesn’t swallow the next scheduled one', () => {
    setGm({ tradeWindowEveryRounds: 1 })
    insertWindow(db, currentSeason(db).id, currentSeason(db).phase, null, 'manual', Date.now())
    expect(gm.onRound('test', db, dir, currentSeason(db).id, 1)).toBe(true)
    const windows = db.prepare('SELECT status, round FROM trade_windows ORDER BY id').all()
    expect(windows).toEqual([
      { status: 'closed', round: null },
      { status: 'open', round: 1 },
    ])
  })

  it('a stuck window closed by a round’s last game still gets its rumors posted', async () => {
    setGm({ tradeWindowEveryRounds: 1 })
    startSeason(db)
    story.afterChange('test', db, dir)
    const season = currentSeason(db)
    const stuck = insertWindow(db, season.id, season.phase, null, 'manual', Date.now())
    const n = createNegotiation(db, stuck, { a: 't1', b: 't2', aGives: ['p1'], bGives: ['p7'], aCards: [], bCards: [] }, Date.now())
    updateNegotiation(db, n, { status: 'rejected' })
    for (const g of listGames(db, season.id).filter((x) => x.stage === 'regular' && x.round === 1)) {
      const lines = listPlayers(db)
        .filter((p) => p.teamId === g.home || p.teamId === g.away)
        .map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 10 } }))
      recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
    }
    story.afterChange('test', db, dir)
    await drain()
    expect(listEvents(db, 'trade_talks')).toHaveLength(1)
    expect(jobs('event_thread').some((j) => j.input.includes('찌라시'))).toBe(true)
  })

  it('reads a player the way GMs see him named', () => {
    const league = readLeague(db, dir)
    const p = listPlayers(db)[1]!
    expect(resolvePlayer(league, `${p.name}(가람고 SG · OVR 71)`)).toBe(p.id)
    expect(resolvePlayer(league, p.name)).toBe(p.id)
    expect(resolvePlayer(league, '없는선수')).toBeNull()
  })
})

describe('superstar trades', () => {
  /** 가람고's PG (p1) becomes the league's star; everyone else is 70–75. */
  const star = () => db.prepare("UPDATE ratings SET num = 99 WHERE player_id = 'p1' AND column_id = 'ovr'").run()
  const window = () => {
    const season = currentSeason(db)
    return insertWindow(db, season.id, season.phase, null, 'manual', Date.now())
  }
  const payloads = () => listEvents(db, 'trade_applied').map((e) => e.payload as EventPayloads['trade_applied'])

  it('a deal that moves a star is tagged a blockbuster when it’s made; an ordinary one isn’t', () => {
    star()
    // A trade you make yourself is read the same way.
    expect(tradeIsBlockbuster(db, dir, [{ kind: 'player', playerId: 'p1', from: 't1', to: 't3' }, { kind: 'player', playerId: 'p15', from: 't3', to: 't1' }])).toBe(true)
    expect(tradeIsBlockbuster(db, dir, [{ kind: 'player', playerId: 'p16', from: 't3', to: 't5' }, { kind: 'player', playerId: 'p28', from: 't5', to: 't3' }])).toBe(false)
    const w = window()
    const big = createNegotiation(db, w, { a: 't2', b: 't1', aGives: ['p8'], bGives: ['p1'], aCards: [], bCards: [] }, Date.now())
    const small = createNegotiation(db, w, { a: 't3', b: 't4', aGives: ['p14'], bGives: ['p20'], aCards: [], bCards: [] }, Date.now())
    expect(settleDeal(db, dir, getNegotiation(db, big)!, Date.now())).toBe('accepted')
    expect(settleDeal(db, dir, getNegotiation(db, small)!, Date.now())).toBe('accepted')
    const [first, second] = payloads()
    expect(first).toMatchObject({ negotiationId: big, blockbuster: true })
    expect(second).not.toHaveProperty('blockbuster')
    // The season has had its blockbuster: the same star moving on isn't covered big twice.
    expect(tradeIsBlockbuster(db, dir, [{ kind: 'player', playerId: 'p1', from: 't2', to: 't3' }, { kind: 'player', playerId: 'p15', from: 't3', to: 't2' }])).toBe(false)
  })

  it('GMs read packages and consolidations plainly: what each side sends, card worth, strength, the pecking order and shot shares', () => {
    star()
    // A card-swap league in season: every school holds its cards.
    db.prepare("UPDATE league_config SET json = json_set(json, '$.draft', json(?))").run(JSON.stringify(defaultCardSwap(8)))
    startSeason(db)
    const league = readLeague(db, dir)
    const data = readMarket(league)
    const cards = data.market.cards.filter((c) => c.ownerTeamId === 't2').map((c) => c.id)
    // 나람고 sends two of its middle players (PF 73, C 74) and two cards for 가람고's star and its weakest (SG 71).
    const id = createNegotiation(db, window(), { a: 't2', b: 't1', aGives: ['p10', 'p11'], bGives: ['p1', 'p2'], aCards: cards.slice(0, 2), bCards: [] }, Date.now())
    const input = respondInput(league, data, getNegotiation(db, id)!, 1, false, '받아 주시죠')
    expect(input.context).toContain('[통합: 우리 에이스 + 벤치 ↔ 상대 주전 둘 · 패키지: 선수 + 카드(상대가 2장)]')
    expect(input.context).toMatch(/나람고 \d번 카드\(가치 약 \d+\)/)
    expect(input.context).toContain('카드 가치 들어옴')
    expect(input.context).toMatch(/거래 뒤 우리 서열과 기대 슛 비중\(코드가 계산, 괄호는 지금\): 1\. \S+ \d+%\(지금 \d+%\)/)
    expect(input.context).toMatch(/\d+%\(새로 옴\)/)
    const kinds = gmKinds(db, dir, { queue: () => {}, changed: () => {} })
    const shapes = '패키지("주전 + 카드")와 통합("에이스 + 벤치 ↔ 주전 둘")도 평범한 방식이다'
    expect(kinds[1]!.prompt(input as never)).toContain(shapes)
    // The proposer's options carry the same: its order after each deal, and the same line in its instructions.
    const intent = intentInput(league, data, input.windowId, null, [{ teamId: 't2', options: [scoreDeal(data.market, getNegotiation(db, id)!.deal)] }])
    expect(intent.context).toContain('O1 · 가람고와 [통합: 상대 에이스 + 벤치 ↔ 우리 주전 둘 · 패키지: 선수 + 카드(우리가 2장)]')
    expect(intent.context).toContain('거래 뒤 우리 서열과 슛 비중: 1. ')
    expect(kinds[0]!.prompt(intent as never)).toContain(shapes)
  })

  it('demo GMs still trade with packages on the table, and every deal goes through the League engine', async () => {
    db.prepare("UPDATE league_config SET json = json_set(json, '$.draft', json(?))").run(JSON.stringify(defaultCardSwap(8)))
    startSeason(db)
    star()
    gm.openWindow('test', db, dir, 'manual', null)
    await drain()
    const [w] = gm.windows(db)
    expect(w!.negotiations.filter((n) => n.status === 'accepted').length).toBeGreaterThan(0)
    expect(w!.negotiations.filter((n) => n.status === 'failed')).toEqual([])
    expect(listTrades(db, currentSeason(db).id).filter((t) => t.source === 'gm').length).toBe(w!.negotiations.filter((n) => n.status === 'accepted').length)
  })
})
