import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import type { LeagueSetup } from '@shared/setup'
import { openDb, type Db } from './db'
import { appendEvent, currentSeason, listEvents, seedLeague } from './league'
import {
  applyTrade,
  closeProtection,
  draftMove,
  draftView,
  finishDraft,
  giveAward,
  listAwards,
  listCards,
  listChecklist,
  listTrades,
  markApplied,
  removeAward,
  rosterHistory,
  startNextSeason,
  vetoDraftSwap,
  vetoTrade,
} from './moves'
import { RuleError } from './rules'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from './season'
import { ko } from '../renderer/i18n/ko'

function league(change?: (s: LeagueSetup) => void): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  setup.config.trades.oncePerSeason = { enabled: true, until: 'draft' }
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 4, cards: 2 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
  }
  change?.(setup)
  seedLeague(db, setup)
  return db
}

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}
const team = (db: Db, player: string) => (db.prepare('SELECT team_id, slot_id FROM players WHERE id = ?').get(player) as { team_id: string; slot_id: string })

function playSeason(db: Db) {
  startSeason(db)
  playOut(db)
}

/** Plays the rest of a started season through the playoffs: lower team number wins. */
function playOut(db: Db) {
  const play = (filter: (stage: string) => boolean) => {
    for (;;) {
      const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && filter(g.stage))
      if (open.length === 0) return
      for (const g of open) {
        const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
    }
  }
  play((s) => s === 'regular')
  startPlayoffs(db)
  play((s) => s !== 'regular')
  finishPlayoffs(db)
}

describe('trades', () => {
  it('moves players, locks them, blocks games until made in 2K, and can be vetoed', () => {
    const db = league()
    startSeason(db)
    const id = applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    expect(team(db, 'p1')).toEqual({ team_id: 't2', slot_id: 'pg' })
    expect(listEvents(db, 'trade_applied')).toHaveLength(1)

    // Locked: p1 can't be traded again this season.
    expect(
      refusal(() =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p1', from: 't2', to: 't3' },
          { kind: 'player', playerId: 'p13', from: 't3', to: 't2' },
        ]),
      ),
    ).toEqual(['player-locked'])

    // t1's next game waits for the move to be made in 2K.
    const game = listGames(db, currentSeason(db).id).find((g) => g.home === 't1' || g.away === 't1')!
    expect(refusal(() => recordScore(db, { gameId: game.id, homeScore: 90, awayScore: 80, lines: null }))).toEqual(['pending-2k-moves'])

    const [item] = listChecklist(db)
    expect(item!.moves).toEqual([
      { playerId: 'p7', toTeamId: 't1', toSlotId: 'pg' },
      { playerId: 'p1', toTeamId: 't2', toSlotId: 'pg' },
    ])

    vetoTrade(db, id)
    expect(team(db, 'p1').team_id).toBe('t1')
    // Where each started and has been, vetoed trade or not (lore files are matched by it).
    expect(rosterHistory(db)).toEqual(
      new Map([
        ['p1', { first: 't1', teams: ['t1', 't2'] }],
        ['p7', { first: 't2', teams: ['t2', 't1'] }],
      ]),
    )
    expect(listTrades(db, currentSeason(db).id)[0]!.status).toBe('vetoed')
    expect(listChecklist(db)).toEqual([])
    recordScore(db, { gameId: game.id, homeScore: 90, awayScore: 80, lines: null })
  })

  it('can’t veto once the move is made in 2K', () => {
    const db = league()
    startSeason(db)
    const id = applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    markApplied(db, listChecklist(db)[0]!.id)
    expect(refusal(() => vetoTrade(db, id))).toEqual(['already-in-2k'])
  })

  it('won’t veto a trade once its player or card moved again since, there and back included; a vetoed move doesn’t count', () => {
    const db = league((s) => void (s.config.trades.oncePerSeason = { enabled: false, until: 'draft' }))
    startSeason(db)
    const trade = (player: string, from: string, to: string, other: string) =>
      applyTrade(db, [
        { kind: 'player', playerId: player, from, to },
        { kind: 'player', playerId: other, from: to, to: from },
      ])
    // p1 goes t1 → t2 (for p7), on to t3 (for p13), and back to t2.
    const first = trade('p1', 't1', 't2', 'p7')
    const on = trade('p1', 't2', 't3', 'p13')
    const back = trade('p1', 't3', 't2', 'p13')
    expect(team(db, 'p1').team_id).toBe('t2')
    expect(refusal(() => vetoTrade(db, first))).toEqual(['moved-since'])
    expect(refusal(() => vetoTrade(db, on))).toEqual(['moved-since'])
    // Undone from the latest back, each veto is allowed.
    vetoTrade(db, back)
    vetoTrade(db, on)
    vetoTrade(db, first)
    expect([team(db, 'p1'), team(db, 'p7'), team(db, 'p13')].map((p) => p.team_id)).toEqual(['t1', 't2', 't3'])

    // A card there and back too.
    const card = listCards(db, currentSeason(db).id).find((c) => c.ownerTeamId === 't1')!
    const cardTrade = (from: string, to: string) => applyTrade(db, [{ kind: 'card', cardId: card.id, from, to }])
    const cardFirst = cardTrade('t1', 't2')
    cardTrade('t2', 't3')
    cardTrade('t3', 't2')
    expect(refusal(() => vetoTrade(db, cardFirst))).toEqual(['moved-since'])
  })

  it('won’t veto a late trade once the new team protected its player in the draft', () => {
    const db = league()
    startSeason(db)
    for (const g of listGames(db, currentSeason(db).id)) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
    // After the last regular-season game, between two teams out of the playoffs, not yet made in 2K.
    const late = applyTrade(db, [
      { kind: 'player', playerId: 'p37', from: 't7', to: 't8' },
      { kind: 'player', playerId: 'p43', from: 't8', to: 't7' },
    ])
    playOut(db)
    expect(currentSeason(db).phase).toBe('draft')
    draftMove(db, { kind: 'protect', teamId: 't8', playerId: 'p37' })
    expect(refusal(() => vetoTrade(db, late))).toEqual(['veto-protected'])
    expect(team(db, 'p37').team_id).toBe('t8')
  })

  it('trades guaranteed cards in season and counts them against the cap', () => {
    const db = league()
    startSeason(db)
    const t1Cards = listCards(db, currentSeason(db).id).filter((c) => c.ownerTeamId === 't1')
    expect(t1Cards).toHaveLength(2)
    applyTrade(db, [{ kind: 'card', cardId: t1Cards[0]!.id, from: 't1', to: 't2' }])
    expect(listCards(db, currentSeason(db).id).find((c) => c.id === t1Cards[0]!.id)!.ownerTeamId).toBe('t2')
    // Card-only trades don't touch rosters, so nothing to do in 2K.
    expect(listChecklist(db)).toEqual([])
  })
})

describe('the draft', () => {
  it('protects, swaps in turn order, and closes', () => {
    const db = league()
    playSeason(db)
    expect(currentSeason(db).phase).toBe('draft')
    let view = draftView(db)
    // Worst record picks first: t8 (lowest seed numbers win every game).
    expect(view.order[0]).toBe('t8')
    expect(view.protectionOpen).toBe(true)

    // t1 protects its PG; the card is picked for it (its last).
    draftMove(db, { kind: 'protect', teamId: 't1', playerId: 'p1' })
    view = draftView(db)
    const next = view.next!
    // Swaps wait until protection is closed.
    expect(
      refusal(() => draftMove(db, { kind: 'swap', teamId: 't8', cardId: next.id, playerId: 'p43', targetPlayerId: 'p2' })),
    ).toEqual(['protection-open'])
    closeProtection(db)
    expect(next.ownerTeamId).toBe('t8')
    expect(
      refusal(() => draftMove(db, { kind: 'swap', teamId: 't8', cardId: next.id, playerId: 'p43', targetPlayerId: 'p1' })),
    ).toEqual(['target-protected'])
    draftMove(db, { kind: 'swap', teamId: 't8', cardId: next.id, playerId: 'p43', targetPlayerId: 'p2' })
    expect(team(db, 'p2')).toEqual({ team_id: 't8', slot_id: 'pg' })
    expect(team(db, 'p43')).toEqual({ team_id: 't1', slot_id: 'sg' })
    expect(rosterHistory(db)).toEqual(
      new Map([
        ['p43', { first: 't8', teams: ['t8', 't1'] }],
        ['p2', { first: 't1', teams: ['t1', 't8'] }],
      ]),
    )

    view = draftView(db)
    expect(view.protectionOpen).toBe(false)
    expect(view.protectedPlayers).toEqual(expect.arrayContaining(['p1', 'p2', 'p43']))
    expect(listChecklist(db)[0]!.moves).toEqual([
      { playerId: 'p43', toTeamId: 't1', toSlotId: 'sg' },
      { playerId: 'p2', toTeamId: 't8', toSlotId: 'pg' },
    ])

    finishDraft(db)
    expect(currentSeason(db).phase).toBe('offseason')
    expect(refusal(() => startNextSeason(db, '시즌 2'))).toEqual(['pending-2k-moves'])
    markApplied(db, listChecklist(db)[0]!.id)
    startNextSeason(db, '시즌 2')
    expect(currentSeason(db)).toMatchObject({ label: '시즌 2', phase: 'preseason' })
  })
})

describe('awards', () => {
  it('gives awards within their limits and removes them', () => {
    const db = league()
    expect(refusal(() => giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' }))).toEqual(['wrong-phase'])
    startSeason(db)
    expect(giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' })).toBeGreaterThan(0)
    expect(refusal(() => giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p2' }))).toEqual(['award-full'])
    expect(refusal(() => giveAward(db, { awardId: 'potw', period: 'x', teamRank: 1, playerId: 'p2' }))).toEqual(['bad-period'])
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p2' })
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 2, playerId: 'p3' })
    expect(refusal(() => giveAward(db, { awardId: 'all-league', period: '', teamRank: 4, playerId: 'p3' }))).toEqual(['bad-rank'])
    expect(refusal(() => giveAward(db, { awardId: 'all-league', period: '', teamRank: 1, playerId: 'p3' }))).toEqual(['award-duplicate'])
    expect(refusal(() => giveAward(db, { awardId: 'potw', period: 'm1', teamRank: 1, playerId: 'p4' }))).toEqual(['bad-period'])
    expect(refusal(() => giveAward(db, { awardId: 'finals-mvp', period: '', teamRank: 1, playerId: 'p4' }))).toEqual(['award-too-early'])
    const list = listAwards(db, currentSeason(db).id)
    expect(list).toHaveLength(3)
    removeAward(db, list[0]!.id)
    expect(listAwards(db, currentSeason(db).id)).toHaveLength(2)
  })

  it('moves an award back with its winner when the trade he was in is vetoed', () => {
    const db = league()
    startSeason(db)
    // An award before the trade keeps t1; one won while the trade stood follows him back on the veto.
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p1' })
    const trade = applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' })
    const team = () => Object.fromEntries(listAwards(db, currentSeason(db).id).map((a) => [a.awardId, a.teamId]))
    expect(team()).toEqual({ potw: 't1', mvp: 't2' })
    vetoTrade(db, trade)
    expect(team()).toEqual({ potw: 't1', mvp: 't1' })
  })
})

describe('a past season', () => {
  it('keeps its trades (cards named even after they carried over), draft log and awards, with the teams of then', () => {
    const db = league((s) => {
      if (s.config.draft.kind === 'card-swap') s.config.draft.unusedCards = 'carry-over'
    })
    startSeason(db)
    const first = currentSeason(db).id
    // p1 plays one game for t1 and wins the MVP there, then is traded to t2.
    const game = listGames(db, first).find((g) => g.home === 't1' || g.away === 't1')!
    recordScore(db, {
      gameId: game.id,
      homeScore: game.home === 't1' ? 100 : 90,
      awayScore: game.home === 't1' ? 90 : 100,
      lines: [{ playerId: 'p1', teamId: 't1', stats: { pts: 20 } }],
    })
    const award = giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' })
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    markApplied(db, listChecklist(db)[0]!.id)
    const card = listCards(db, first).find((c) => c.ownerTeamId === 't1')!
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
    for (const stage of ['regular', 'playoffs'] as const) {
      if (stage === 'playoffs') startPlayoffs(db)
      for (;;) {
        const open = listGames(db, first).filter((g) => g.status === 'scheduled' && (g.stage === 'regular') === (stage === 'regular'))
        if (open.length === 0) break
        for (const g of open) {
          const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
          recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
        }
      }
    }
    finishPlayoffs(db)
    draftMove(db, { kind: 'protect', teamId: 't1', playerId: 'p7' })
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')

    // The traded card was never played, so it carried over into season 2; season 1 still lists it, marked so.
    expect(listCards(db, first).find((c) => c.id === card.id)).toMatchObject({ ownerTeamId: 't2', status: 'held', issuedSeasonId: first, carriedTo: currentSeason(db).id })
    const cardTrade = listTrades(db, first).find((tr) => tr.items.some((i) => i.kind === 'card'))!
    expect(cardTrade.items[0]).toMatchObject({ cardId: card.id, card: { originalTeamId: 't1', number: card.number, issuedSeasonId: first } })

    // The draft is over: its log stays, nothing is open.
    const draft = draftView(db, first)
    expect(draft).toMatchObject({ protectionOpen: false, next: null })
    expect(draft.actions.map((a) => [a.kind, a.teamId, a.playerId])).toEqual([['protect', 't1', 'p7']])
    expect(draft.protectedPlayers).toEqual(['p7'])
    expect(draft.order[0]).toBe('t8')

    // The award names the team he won it for, not his team now; and it can't be taken back.
    expect(team(db, 'p1').team_id).toBe('t2')
    expect(listAwards(db, first)).toEqual([expect.objectContaining({ id: award, playerId: 'p1', teamId: 't1' })])
    expect(refusal(() => removeAward(db, award))).toEqual(['past-season-award'])
    // This season's award names his team now.
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p1' })
    expect(listAwards(db, currentSeason(db).id)[0]).toMatchObject({ playerId: 'p1', teamId: 't2' })
    expect(refusal(() => draftView(db, 999))).toEqual(['unknown-season'])
  })
})

describe('review fixes', () => {
  it('vetoes the latest draft swap and gives the card back', () => {
    const db = league()
    playSeason(db)
    closeProtection(db)
    const next = draftView(db).next!
    const before = [team(db, 'p43'), team(db, 'p2')]
    const id = draftMove(db, { kind: 'swap', teamId: 't8', cardId: next.id, playerId: 'p43', targetPlayerId: 'p2' })
    vetoDraftSwap(db, id)
    expect([team(db, 'p43'), team(db, 'p2')]).toEqual(before)
    expect(draftView(db).next!.id).toBe(next.id)
    expect(listChecklist(db)).toEqual([])
    expect(listEvents(db, 'move_vetoed').map((e) => e.payload)).toEqual([{ kind: 'draft-swap', refId: id }])
  })

  it('carries unused cards into the next season without clashing with new ones', () => {
    const db = league((s) => {
      if (s.config.draft.kind === 'card-swap') s.config.draft.unusedCards = 'carry-over'
    })
    playSeason(db)
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')
    startSeason(db)
    const cards = listCards(db, currentSeason(db).id)
    // Last season's 2–3 cards per team carried over, plus this season's guaranteed 2.
    const t1 = cards.filter((c) => c.ownerTeamId === 't1')
    expect(t1.length).toBeGreaterThan(2)
  })

  it('lets a card-only trade be vetoed only in the phase it was made', () => {
    const db = league()
    startSeason(db)
    const card = listCards(db, currentSeason(db).id).find((c) => c.ownerTeamId === 't1')!
    const id = applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
    expect(listTrades(db, currentSeason(db).id)[0]!.pendingIn2k).toBe(false)
    db.prepare("UPDATE seasons SET phase = 'playoffs'").run()
    expect(refusal(() => vetoTrade(db, id))).toEqual(['veto-window-closed'])
  })
})

describe('draft rules, reviewed', () => {
  /** The draft, protection closed: t8 picks first, then t7 (each team's first card, worst first). */
  const swapping = (change?: (s: LeagueSetup) => void) => {
    const db = league(change)
    playSeason(db)
    closeProtection(db)
    return db
  }
  const swap = (db: Db, playerId: string, targetPlayerId: string) => {
    const next = draftView(db).next!
    return draftMove(db, { kind: 'swap', teamId: next.ownerTeamId, cardId: next.id, playerId, targetPlayerId })
  }

  it('protects a player swapped in for the rest of the draft, even where swapped players weren’t protected', () => {
    const db = swapping((s) => {
      if (s.config.draft.kind === 'card-swap') s.config.draft.swappedProtected = false
    })
    // t8 takes t1's p2 for its p43.
    swap(db, 'p43', 'p2')
    expect(draftView(db).next!.ownerTeamId).toBe('t7')
    // Neither can be taken again: p2 (now t8's) nor p43 (now t1's).
    expect(refusal(() => swap(db, 'p37', 'p2'))).toEqual(['target-already-moved'])
    expect(refusal(() => swap(db, 'p37', 'p43'))).toEqual(['target-already-moved'])
    expect(draftView(db).protectedPlayers).toEqual(expect.arrayContaining(['p2', 'p43']))
    expect(draftView(db).movedPlayers.sort()).toEqual(['p2', 'p43'])
    swap(db, 'p37', 'p3')
  })

  it('counts a trade made during the draft as a move within it', () => {
    const db = swapping((s) => void (s.config.trades.phases = ['preseason', 'regular', 'draft']))
    applyTrade(db, [
      { kind: 'player', playerId: 'p13', from: 't3', to: 't4' },
      { kind: 'player', playerId: 'p19', from: 't4', to: 't3' },
    ])
    expect(draftView(db).movedPlayers.sort()).toEqual(['p13', 'p19'])
    expect(refusal(() => swap(db, 'p43', 'p13'))).toEqual(['target-already-moved'])
    expect(refusal(() => swap(db, 'p43', 'p19'))).toEqual(['target-already-moved'])
    // Nor traded on again, even with the once-per-season lock off (it resets at the draft).
    expect(
      refusal(() =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p13', from: 't4', to: 't5' },
          { kind: 'player', playerId: 'p25', from: 't5', to: 't4' },
        ]),
      ),
    ).toEqual(['player-moved-in-draft'])
  })

  it('won’t trade a player swapped in the draft (rule 21), so the swap can still be undone', () => {
    const db = swapping((s) => void (s.config.trades.phases = ['preseason', 'regular', 'draft']))
    const id = swap(db, 'p43', 'p2')
    // p2 (t8 now, at PG) can't go on to t5 for its PG, nor p43 (t1 now) anywhere.
    expect(
      refusal(() =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p2', from: 't8', to: 't5' },
          { kind: 'player', playerId: 'p25', from: 't5', to: 't8' },
        ]),
      ),
    ).toEqual(['player-moved-in-draft'])
    expect(
      refusal(() =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p43', from: 't1', to: 't5' },
          { kind: 'player', playerId: 'p26', from: 't5', to: 't1' },
        ]),
      ),
    ).toEqual(['player-moved-in-draft'])
    vetoDraftSwap(db, id)
    expect(team(db, 'p2').team_id).toBe('t1')
    // Undone, the swap no longer counts: p2 can be traded (once).
    applyTrade(db, [
      { kind: 'player', playerId: 'p2', from: 't1', to: 't5' },
      { kind: 'player', playerId: 'p26', from: 't5', to: 't1' },
    ])
  })

  it('won’t undo a swap once either player was traded since, there and back included (a league from before rule 21)', () => {
    const db = swapping((s) => void (s.config.trades.phases = ['preseason', 'regular', 'draft']))
    const id = swap(db, 'p43', 'p2')
    // As an older version could record them: p2 (t8 now, at PG) to t5 for its PG, and back again.
    const legacyTrade = (from: string, to: string) => {
      const season = currentSeason(db)
      const tradeId = Number(
        db.prepare("INSERT INTO trades (season_id, phase, status, source, note, created_at) VALUES (?, 'draft', 'applied', 'user', '', '')").run(season.id).lastInsertRowid,
      )
      const item = db.prepare("INSERT INTO trade_items (trade_id, kind, from_team_id, to_team_id, player_id, from_slot_id, to_slot_id) VALUES (?, 'player', ?, ?, ?, 'pg', 'pg')")
      item.run(tradeId, from, to, 'p2')
      item.run(tradeId, to, from, 'p25')
      db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(to, 'p2')
      db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(from, 'p25')
      appendEvent(db, 'trade_applied', { tradeId, teams: [from, to], players: ['p2', 'p25'], cards: [] }, season.id)
    }
    legacyTrade('t8', 't5')
    expect(refusal(() => vetoDraftSwap(db, id))).toEqual(['swap-moved-since'])
    legacyTrade('t5', 't8')
    // He's where the swap put him, yet refused.
    expect(team(db, 'p2')).toEqual({ team_id: 't8', slot_id: 'pg' })
    expect(refusal(() => vetoDraftSwap(db, id))).toEqual(['swap-moved-since'])
  })

  it('lets a team trade its own protected player by agreement; then he has moved, and rule 21 holds him', () => {
    const db = league((s) => void (s.config.trades.phases = ['preseason', 'regular', 'draft']))
    playSeason(db)
    draftMove(db, { kind: 'protect', teamId: 't1', playerId: 'p1' })
    // Protected by his card, not moved: t1 may still trade him (the user's call).
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    expect(team(db, 'p1').team_id).toBe('t2')
    expect(draftView(db).movedPlayers.sort()).toEqual(['p1', 'p7'])
    // Not a second time, by t2 or anyone…
    expect(
      refusal(() =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p1', from: 't2', to: 't3' },
          { kind: 'player', playerId: 'p13', from: 't3', to: 't2' },
        ]),
      ),
    ).toEqual(['player-moved-in-draft'])
    // …and no card can take him (or p7, who moved the other way), nor can t2 swap him away.
    closeProtection(db)
    expect(refusal(() => swap(db, 'p43', 'p1'))).toEqual(['target-already-moved'])
    expect(refusal(() => swap(db, 'p43', 'p7'))).toEqual(['target-already-moved'])
    const t2Card = draftView(db).cards.find((c) => c.ownerTeamId === 't2' && c.status === 'held')!
    expect(refusal(() => draftMove(db, { kind: 'swap', teamId: 't2', cardId: t2Card.id, playerId: 'p1', targetPlayerId: 'p43' }))).toContain('player-already-moved')
  })

  it('won’t undo a swap a later turn was played after', () => {
    const db = swapping()
    const id = swap(db, 'p43', 'p2')
    const next = draftView(db).next!
    draftMove(db, { kind: 'pass', teamId: next.ownerTeamId, cardId: next.id })
    expect(refusal(() => vetoDraftSwap(db, id))).toEqual(['veto-latest-only'])
  })
})

describe('trade rules, reviewed', () => {
  const toPlayoffs = (db: Db) => {
    startSeason(db)
    for (;;) {
      const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled')
      if (open.length === 0) break
      for (const g of open) recordScore(db, { gameId: g.id, homeScore: 100, awayScore: 90, lines: null })
    }
    startPlayoffs(db)
  }

  it('locks every player in the playoffs, even when the league ticked the playoffs as a trade phase', () => {
    const db = league((s) => void (s.config.trades.phases = ['preseason', 'regular', 'playoffs']))
    toPlayoffs(db)
    expect(currentSeason(db).phase).toBe('playoffs')
    const trade = [
      { kind: 'player' as const, playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player' as const, playerId: 'p7', from: 't2', to: 't1' },
    ]
    expect(refusal(() => applyTrade(db, trade))).toEqual(['wrong-phase'])
  })

  it('keeps a player traded in the season locked until the draft (or the season’s end, when set so)', () => {
    for (const until of ['draft', 'season-end'] as const) {
      const db = league((s) => {
        s.config.trades.phases = ['preseason', 'regular', 'draft']
        s.config.trades.oncePerSeason = { enabled: true, until }
      })
      startSeason(db)
      applyTrade(db, [
        { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
        { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
      ])
      markApplied(db, listChecklist(db)[0]!.id)
      playOut(db)
      expect(currentSeason(db).phase).toBe('draft')
      const back = () =>
        applyTrade(db, [
          { kind: 'player', playerId: 'p1', from: 't2', to: 't1' },
          { kind: 'player', playerId: 'p7', from: 't1', to: 't2' },
        ])
      if (until === 'draft') expect(back()).toBeGreaterThan(0)
      // Both were in the first trade.
      else expect(refusal(back)).toEqual(['player-locked', 'player-locked'])
    }
  })
})

describe('past seasons, reviewed', () => {
  it('keeps an award’s team when scores had no box lines and he moves in the next preseason', () => {
    const db = league()
    startSeason(db)
    const first = currentSeason(db).id
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' })
    playOut(db)
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    expect(team(db, 'p1').team_id).toBe('t2')
    expect(listAwards(db, first)).toEqual([expect.objectContaining({ playerId: 'p1', teamId: 't1' })])
  })

  it('gives an award in the draft to the team he finished the season with, not the one a swap sent him to', () => {
    const db = league()
    playSeason(db)
    closeProtection(db)
    const next = draftView(db).next!
    draftMove(db, { kind: 'swap', teamId: 't8', cardId: next.id, playerId: 'p43', targetPlayerId: 'p2' })
    expect([team(db, 'p2').team_id, team(db, 'p43').team_id]).toEqual(['t8', 't1'])
    giveAward(db, { awardId: 'finals-mvp', period: '', teamRank: 1, playerId: 'p2' })
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p43' })
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 1, playerId: 'p3' })
    const teams = new Map(listAwards(db, currentSeason(db).id).map((a) => [a.playerId, a.teamId]))
    expect(teams).toEqual(new Map([['p2', 't1'], ['p43', 't8'], ['p3', 't1']]))
  })

  it('lists every card a past season had, through two carry-overs, with who held it when it ended', () => {
    const db = league((s) => {
      if (s.config.draft.kind === 'card-swap') s.config.draft.unusedCards = 'carry-over'
    })
    startSeason(db)
    const first = currentSeason(db).id
    const card = listCards(db, first).find((c) => c.originalTeamId === 't1' && c.number === 1)!
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
    playOut(db)
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')
    const second = currentSeason(db).id
    // In season 2 it changes hands again, and is never played.
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't2', to: 't3' }])
    playSeason(db)
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 3')
    const third = currentSeason(db).id

    // Season 1 still lists every card it issued; the traded one as t2 held it then, carried into season 2.
    const issued = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE issued_season_id = ?').get(id) as { n: number }).n
    expect(listCards(db, first)).toHaveLength(issued(first))
    expect(listCards(db, first).find((c) => c.id === card.id)).toMatchObject({ ownerTeamId: 't2', status: 'held', issuedSeasonId: first, carriedTo: second })
    // Season 2 had it too, beside its own t1 #1 (numbers restart each season), and passed it on.
    const middle = listCards(db, second)
    expect(middle.find((c) => c.id === card.id)).toMatchObject({ ownerTeamId: 't3', issuedSeasonId: first, carriedTo: third })
    expect(middle.filter((c) => c.originalTeamId === 't1' && c.number === 1).map((c) => c.issuedSeasonId)).toEqual([first, second])
    // The season under way has it in its draft, unmarked.
    expect(listCards(db, third).find((c) => c.id === card.id)).toMatchObject({ ownerTeamId: 't3', status: 'held', issuedSeasonId: first, carriedTo: null })
    expect(listCards(db, third).every((c) => c.carriedTo === null)).toBe(true)
  })

  it('refuses a season label another season already has, ignoring spaces and case', () => {
    const db = league()
    playSeason(db)
    closeProtection(db)
    finishDraft(db)
    expect(refusal(() => startNextSeason(db, ' 시즌 1 '))).toEqual(['season-label-taken'])
    expect(refusal(() => startNextSeason(db, '시즌  1'))).toEqual(['season-label-taken'])
    db.prepare("UPDATE seasons SET label = 'Spring League'").run()
    expect(refusal(() => startNextSeason(db, 'spring league'))).toEqual(['season-label-taken'])
    startNextSeason(db, '시즌 2')
    expect(currentSeason(db).label).toBe('시즌 2')
  })
})

describe('what the screens say', () => {
  it('explains every refusal a trade, a veto or a draft move can give', () => {
    const codes = (file: string, call: RegExp) => [...readFileSync(join(__dirname, file), 'utf8').matchAll(call)].map((m) => m[1]!)
    const all = [
      ...codes('moves.ts', /refuse\('([a-z0-9-]+)'/g),
      ...codes('../core/trades.ts', /add\('([a-z0-9-]+)'/g),
      ...codes('../core/draft.ts', /(?:issues\.push\(|return \[)'([a-z0-9-]+)'/g),
    ]
    expect(all).toEqual(expect.arrayContaining(['player-moved-in-draft', 'veto-protected', 'moved-since', 'target-already-moved']))
    for (const code of all) expect((ko.rules as Record<string, unknown>)[code], code).toBeDefined()
  })
})
