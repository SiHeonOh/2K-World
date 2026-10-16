import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleConfig, sampleSetup, twoKConfig, TWO_K_CATEGORIES } from '@shared/testing/fixtures'
import type { Player, Team } from '@shared/setup'
import { defaultCardSwap } from '@shared/config/defaults'
import type { EventPayloads } from '@shared/events'
import { scoreDeal } from '@core/market'
import { openDb, type Db } from '@data/db'
import { addStep, createNegotiation, getNegotiation, insertWindow, updateNegotiation, windowAfterRound } from '@data/gm'
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

  it('with no schedule (every 0) a round never opens a window, but 단장실 still can', () => {
    setGm({ tradeWindowEveryRounds: 0 })
    expect(gm.onRound('test', db, dir, currentSeason(db).id, 1)).toBe(false)
    expect(gm.onRound('test', db, dir, currentSeason(db).id, 5)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_windows').get()).toEqual({ n: 0 })
    const status = gm.status('test', db, dir)
    expect(status.manual).toBe(true)
    expect(status.nextRound).toBeNull()
    const opened = gm.openWindow('test', db, dir, 'manual', null)
    expect(opened.windowId).not.toBeNull()
    expect(gm.status('test', db, dir).open?.id).toBe(opened.windowId)
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

  it('a proposer reads a counter against what it asked for: whom it got instead, the role it loses, its strength and protection', () => {
    // A made-up 2K league of eight: 누리고 (win-now) runs its offense through 도윤재, its only point guard who can.
    const config = twoKConfig()
    config.structure = sampleConfig().structure
    config.season.playoffs = sampleConfig().season.playoffs
    const names = ['누리고', '가람고', '다온고', '한빛고', '나래고', '미르고', '라온고', '바다고']
    const teams: Team[] = names.map((shortName, i) => ({ id: `s${i + 1}`, name: `${shortName}등학교`, shortName, divisionId: config.structure.divisions[i % 4]!.id, control: 'ai', colors: [] }))
    const slots = config.roster.slots.map((s) => s.id)
    const keys = TWO_K_CATEGORIES.map((n) => n.toLowerCase().replace(/\s+/g, '-'))
    const six: Record<string, [string, number, string][]> = {
      s1: [
        ['도윤재', 88, 'B+ B+ B- C- B A C- A- A-'],
        ['김하람', 96, 'A A A+ B- A B C+ A+ A-'],
        ['이서진', 85, 'B C B+ A A C+ B+ A C+'],
        ['박태오', 84, 'A B+ A B- C+ A- B A+ C+'],
        ['정우빈', 88, 'A- D D A+ C- C A+ B C+'],
        ['최민재', 76, 'C+ C C C- B+ C- C A+ D+'],
      ],
      s2: [
        ['한지후', 83, 'C+ B+ A+ D+ C+ A- C B+ B'],
        ['윤시우', 83, 'B B A+ B- A+ B- C+ A+ B+'],
        ['강도현', 87, 'B+ A- A B+ B+ B- B A+ B+'],
        ['임건우', 81, 'C+ C- C- A B- C- A A D-'],
        ['오준서', 75, 'C B- B A B- C C+ B C-'],
        ['서은호', 72, 'D+ B A C- B+ C C- C+ D'],
      ],
    }
    const players: Player[] = teams.flatMap((t, ti) =>
      slots.map((slotId, si) => {
        const [name, ovr, grades] = six[t.id]?.[si] ?? [`${names[ti]!.slice(0, 2)}${si + 1}호`, 78 + ((ti + si) % 6), 'B B B B B B B B B']
        return { id: `${t.id}p${si + 1}`, teamId: t.id, name, slotId, height: '', nicknames: [], notes: '', ratings: { ovr, ...Object.fromEntries(keys.map((k, i) => [k, grades.split(' ')[i]!])) } }
      }),
    )
    const own = mkdtempSync(join(tmpdir(), '2kw-gm-ask-'))
    const d = openDb(join(own, 'league.db'))
    try {
      seedLeague(d, { config, teams, players })
      mkdirSync(join(own, 'lore', 'teams', '누리고'), { recursive: true })
      writeFileSync(
        join(own, 'lore', 'teams', '누리고', '누리고 단장.md'),
        `---\nid: 누리고 단장\nname: 김단장\nteam: 누리고\nphilosophy: win-now\ntraits: { risk: 4, patience: 2, star_chasing: 4, regional_pride: 4, ego: 4 }\nnegotiation: hardball\n---\n`,
      )
      startSeason(d)
      const league = readLeague(d, own)
      const data = readMarket(league)
      const id = (name: string) => players.find((p) => p.name === name)!.id
      const cards = data.market.cards.filter((c) => c.ownerTeamId === 's1').map((c) => c.id).slice(0, 2)
      const asked = { a: 's1', b: 's2', aGives: [id('정우빈'), id('도윤재')], bGives: [id('강도현'), id('윤시우')], aCards: cards, bCards: [] }
      const counter = { a: 's1', b: 's2', aGives: [id('도윤재'), id('최민재')], bGives: [id('윤시우'), id('서은호')], aCards: cards, bCards: [] }
      const season = currentSeason(d)
      const n = createNegotiation(d, insertWindow(d, season.id, season.phase, null, 'manual', Date.now()), asked, Date.now())
      addStep(d, { negotiationId: n, round: 1, teamId: 's1', action: 'offer', deal: asked, message: '', note: '', report: null, trust: 0, jobId: null }, Date.now())
      updateNegotiation(d, n, { deal: counter })
      const input = respondInput(league, data, getNegotiation(d, n)!, 2, true, '이렇게라면 하겠습니다')
      expect(input.context).toContain('처음 원했던 거래와 비교(코드가 계산): 원했던 강도현 대신 서은호: 가치 -')
      expect(input.context).toContain('우리가 보내는 쪽: 정우빈 대신 최민재')
      expect(input.context).toContain('역할: 이 거래 뒤 볼 핸들러 없음')
      expect(input.context).toMatch(/드래프트 예상 카드 \d장\(거래 전 \d장\) · 지킬 선수 \d명/)
      expect(input.context).toMatch(/우리 팀: (경쟁권|중위권|리빌딩) \(컨퍼런스 순위/)
      // No game played yet: the early-season bar is on.
      expect(input.context).toContain('시즌 초반이라 이 거래의 효용이 0.6 이상은 돼야 확실히 좋은 거래다')
      expect(input.report.bar).toBe(0.6)
      expect(input.report).toMatchObject({ rolesLost: ['handler'], versusAsk: { dropped: [id('강도현')], added: [id('서은호')] } })
      expect(input.report.strengthAfter).toBeLessThan(input.report.strengthBefore)
      expect(input.report.utility).toBeLessThan(0)
      expect(input.report.versusAsk!.value).toBeLessThan(0)
      // The proposer's instructions: judged against what it wanted and its team's needs, not just a little plus.
      expect(gmKinds(d, own, { queue: () => {}, changed: () => {} })[1]!.prompt(input as never)).toContain('효용이 조금 플러스라는 것만으로 받지 않는다')
    } finally {
      d.close()
      rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
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
