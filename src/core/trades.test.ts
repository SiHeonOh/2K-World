import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { checkTrade, playerTradesOpen, type TradeContext, type TradeItem } from './trades'

function context(over: Partial<TradeContext> = {}): TradeContext {
  const { config, teams, players } = sampleSetup()
  config.trades.oncePerSeason = { enabled: true, until: 'draft' }
  config.draft = { ...defaultCardSwap(8), cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' } }
  return {
    config,
    phase: 'regular',
    teams: teams.map((t) => ({ id: t.id, control: t.control })),
    players: players.map((p) => ({ id: p.id, teamId: p.teamId, slotId: p.slotId })),
    cards: [
      { id: 1, ownerTeamId: 't1', status: 'held' },
      { id: 2, ownerTeamId: 't1', status: 'held' },
      { id: 3, ownerTeamId: 't2', status: 'used' },
    ],
    lockedPlayers: new Set(),
    cardTradeCounts: new Map(),
    draftMoved: new Set(),
    ...over,
  }
}

// sampleSetup: team t1 has p1..p6 (pg, sg, sf, pf, c, bench); t2 has p7..p12.
const swap = (a: string, b: string): TradeItem[] => [
  { kind: 'player', playerId: a, from: 't1', to: 't2' },
  { kind: 'player', playerId: b, from: 't2', to: 't1' },
]
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code)

describe('checkTrade', () => {
  it('accepts a 1-for-1 swap and trades slots', () => {
    const r = checkTrade(swap('p1', 'p7'), context())
    expect(r.ok).toBe(true)
    expect(r.moves).toEqual([
      { playerId: 'p7', from: 't2', to: 't1', fromSlotId: 'pg', toSlotId: 'pg' },
      { playerId: 'p1', from: 't1', to: 't2', fromSlotId: 'pg', toSlotId: 'pg' },
    ])
  })

  it('gives the incoming player the outgoing player’s slot across positions', () => {
    const r = checkTrade(swap('p1', 'p11'), context())
    expect(r.ok).toBe(true)
    expect(r.moves.find((m) => m.playerId === 'p11')!.toSlotId).toBe('pg')
    expect(r.moves.find((m) => m.playerId === 'p1')!.toSlotId).toBe('c')
  })

  it('refuses trades outside the allowed phases and in the playoffs', () => {
    expect(codes(checkTrade(swap('p1', 'p7'), context({ phase: 'playoffs' })))).toEqual(['wrong-phase'])
    const ctx = context({ phase: 'playoffs' })
    expect(codes(checkTrade([{ kind: 'card', cardId: 1, from: 't1', to: 't2' }], ctx))).toEqual(['wrong-phase'])
  })

  it('locks every player in the playoffs even when the league ticked the playoffs as a trade phase', () => {
    const ctx = context({ phase: 'playoffs' })
    ctx.config.trades.phases = ['preseason', 'regular', 'playoffs', 'draft']
    expect(codes(checkTrade(swap('p1', 'p7'), ctx))).toEqual(['wrong-phase'])
    expect(playerTradesOpen(ctx.config, 'playoffs')).toBe(false)
    expect(playerTradesOpen(ctx.config, 'draft')).toBe(true)
    expect(playerTradesOpen(ctx.config, 'offseason')).toBe(false)
  })

  it('locks a player traded once this season', () => {
    expect(codes(checkTrade(swap('p1', 'p7'), context({ lockedPlayers: new Set(['p7']) })))).toEqual(['player-locked'])
  })

  it('keeps a player moved within the draft where he is until it ends (rule 21), whatever the once-per-season setting', () => {
    const ctx = context({ phase: 'draft', draftMoved: new Set(['p7']) })
    ctx.config.trades.phases = ['regular', 'draft']
    ctx.config.trades.oncePerSeason = { enabled: false, until: 'draft' }
    expect(codes(checkTrade(swap('p1', 'p7'), ctx))).toEqual(['player-moved-in-draft'])
    expect(checkTrade(swap('p2', 'p8'), ctx).ok).toBe(true)
    // Only in the draft.
    expect(checkTrade(swap('p1', 'p7'), { ...ctx, phase: 'regular' }).ok).toBe(true)
  })

  it('keeps frozen teams out', () => {
    const ctx = context()
    ;(ctx.teams as { id: string; control: string }[])[1]!.control = 'frozen'
    expect(codes(checkTrade(swap('p1', 'p7'), ctx))).toEqual(['team-frozen'])
  })

  it('needs exactly two teams and players on the giving team', () => {
    expect(codes(checkTrade([], context()))).toEqual(['empty-trade'])
    expect(codes(checkTrade([{ kind: 'player', playerId: 'p1', from: 't1', to: 't1' }], context()))).toContain('two-teams')
    expect(
      codes(
        checkTrade(
          [
            { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
            { kind: 'player', playerId: 'p13', from: 't3', to: 't1' },
          ],
          context(),
        ),
      ),
    ).toContain('two-teams')
    expect(codes(checkTrade(swap('p7', 'p1'), context()))).toContain('player-not-on-team')
  })

  it('needs equal player counts, then valid rosters', () => {
    const r = checkTrade([{ kind: 'player', playerId: 'p1', from: 't1', to: 't2' }], context())
    expect(codes(r)).toEqual(['player-count-mismatch'])
    const ctx = context()
    ctx.config.trades.equalPlayerCount = false
    expect(codes(checkTrade([{ kind: 'player', playerId: 'p1', from: 't1', to: 't2' }], ctx))).toEqual(
      expect.arrayContaining(['roster-size', 'roster-slot']),
    )
  })

  it('matches slots in a 2-for-2 before falling back to order', () => {
    const items: TradeItem[] = [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p5', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p11', from: 't2', to: 't1' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ]
    const r = checkTrade(items, context())
    expect(r.ok).toBe(true)
    const slot = (id: string) => r.moves.find((m) => m.playerId === id)!.toSlotId
    expect([slot('p11'), slot('p7'), slot('p1'), slot('p5')]).toEqual(['c', 'pg', 'pg', 'c'])
  })

  it('honours a named slot and catches slot clashes', () => {
    const items: TradeItem[] = [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2', toSlotId: 'sg' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ]
    expect(codes(checkTrade(items, context()))).toEqual(['roster-slot', 'roster-slot'])
  })

  it('checks cards: ownership, status and the in-season cap', () => {
    const card = (id: number, from = 't1', to = 't2'): TradeItem => ({ kind: 'card', cardId: id, from, to })
    expect(checkTrade([card(1)], context()).ok).toBe(true)
    expect(codes(checkTrade([card(3, 't2', 't1')], context()))).toEqual(['card-used'])
    expect(codes(checkTrade([card(1, 't2', 't1')], context()))).toEqual(['card-not-owned'])
    const capped = context({ cardTradeCounts: new Map([['t1', { given: 3, received: 0, trades: 3 }]]) })
    expect(codes(checkTrade([card(1)], capped))).toEqual(['card-cap'])
    expect(checkTrade([card(1)], { ...capped, phase: 'offseason' }).ok).toBe(true)
  })

  it('can forbid cards on top of a player trade', () => {
    const ctx = context()
    ctx.config.trades.cardsWithPlayers = false
    const items = [...swap('p1', 'p7'), { kind: 'card' as const, cardId: 1, from: 't1', to: 't2' }]
    expect(codes(checkTrade(items, ctx))).toEqual(['cards-with-players'])
  })
})
