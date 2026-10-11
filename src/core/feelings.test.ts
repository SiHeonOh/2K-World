import { describe, expect, it } from 'vitest'
import { belonging, FEELING_RULES, replayFeelings, wantingOut, type FeelingFact } from './feelings'
import { DEFAULT_TRAITS } from './mood'

const games = (n: number, won = true, benched = false): FeelingFact[] => Array.from({ length: n }, () => ({ kind: 'game', won, benched }))
const start: FeelingFact = { kind: 'arrive', teamId: 'a', how: 'start' }

describe('lasting feelings', () => {
  it('attachment builds with games together, faster for a loyal player, and stays within 0..100', () => {
    const loyal = replayFeelings({ ...DEFAULT_TRAITS, loyalty: 5 }, [start, ...games(30)])
    const drifter = replayFeelings({ ...DEFAULT_TRAITS, loyalty: 1 }, [start, ...games(30)])
    expect(loyal.attachment).toBeGreaterThan(drifter.attachment)
    expect(drifter.attachment).toBeGreaterThan(10)
    expect(replayFeelings({ ...DEFAULT_TRAITS, loyalty: 5 }, [start, ...games(400)]).attachment).toBe(100)
    expect(loyal.why.attachment[0]!.key).toBe('start')
  })

  it("a friend sent away hurts trust, and the hurt fades by half over the half-life", () => {
    const now = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'friend', name: '홍길동', strength: 4, joined: false }])
    expect(now.trust).toBe(-20)
    expect(now.why.trust[0]).toEqual({ key: 'friend_left', name: '홍길동', value: -20 })
    // Losses add nothing here: competitiveness 0 makes results count for nothing, leaving only the fade.
    const later = replayFeelings({ ...DEFAULT_TRAITS, competitiveness: 0 }, [start, { kind: 'friend', name: '홍길동', strength: 4, joined: false }, ...games(FEELING_RULES.trustHalfLife)])
    expect(later.trust).toBe(-10)
  })

  it('a request that outlives windows, being shopped and being benched all wear trust down', () => {
    const f = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'ignored', public: true }, { kind: 'ignored', public: false }, { kind: 'shopped', teamId: 'a' }])
    expect(f.trust).toBe(-50)
    const benched = replayFeelings({ ...DEFAULT_TRAITS, ego: 5 }, [start, ...games(10, true, true)])
    const starter = replayFeelings({ ...DEFAULT_TRAITS, ego: 5 }, [start, ...games(10, true, false)])
    expect(benched.trust).toBeLessThan(starter.trust)
    expect(benched.why.trust.map((r) => r.key)).toContain('bench')
  })

  it('a move starts over at the new school; sent away without asking, he holds a grudge against the old one', () => {
    const facts: FeelingFact[] = [start, ...games(20), { kind: 'ignored', public: false }, { kind: 'leave', teamId: 'a', asked: false }, { kind: 'arrive', teamId: 'b', how: 'moved' }]
    const f = replayFeelings(DEFAULT_TRAITS, facts)
    expect(f.trust).toBe(0)
    // 10 × loyalty + 10, less 10 for being moved without asking.
    expect(f.attachment).toBe(30)
    expect(f.grudges).toEqual([expect.objectContaining({ target: { kind: 'team', id: 'a' }, why: 'sent_away' })])
    expect(f.grudges[0]!.value).toBeLessThan(FEELING_RULES.sentAway)
    // Granted his wish: no grudge, and a warm start with the GM who took him.
    const asked = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'leave', teamId: 'a', asked: true }, { kind: 'arrive', teamId: 'b', how: 'requested' }])
    expect(asked.grudges).toEqual([])
    expect(asked.trust).toBe(FEELING_RULES.arrival.requested)
  })

  it("being shopped counts against the school he's at; one he's left by the time it leaks took the slight with it", () => {
    const shopped = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'shopped', teamId: 'a' }])
    expect(shopped.trust).toBe(FEELING_RULES.shopped)
    expect(shopped.attachment).toBe(40 + FEELING_RULES.shoppedAttachment)
    // Sent from a to b first: a's leak changes nothing at b, and the grudge against a is only the one for sending him away.
    const moved: FeelingFact[] = [start, { kind: 'leave', teamId: 'a', asked: false }, { kind: 'arrive', teamId: 'b', how: 'moved' }]
    expect(replayFeelings(DEFAULT_TRAITS, [...moved, { kind: 'shopped', teamId: 'a' }])).toEqual(replayFeelings(DEFAULT_TRAITS, moved))
  })

  it('a secret friend is marked as such; a draft pick stings half as much as being traded away', () => {
    const f = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'friend', name: '홍길동', strength: 2, joined: false, secret: true }])
    expect(f.why.trust[0]).toEqual({ key: 'friend_left', name: '홍길동', secret: true, value: -10 })
    const traded = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'leave', teamId: 'a', asked: false }])
    const taken = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'leave', teamId: 'a', asked: false, taken: true }])
    expect(taken.grudges[0]!.value).toBe(Math.round(traded.grudges[0]!.value / 2))
  })

  it('an average player starts at neutral belonging', () => {
    expect(belonging(0, replayFeelings(DEFAULT_TRAITS, [start]).attachment)).toBe(0)
  })

  it('a new season keeps two thirds of trust and grudges, and all of attachment', () => {
    const before = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'ignored', public: false }, { kind: 'called_out', byId: 'x' }, ...games(0)])
    const after = replayFeelings(DEFAULT_TRAITS, [start, { kind: 'ignored', public: false }, { kind: 'called_out', byId: 'x' }, { kind: 'season' }])
    expect(after.trust).toBe(Math.round(before.trust * (2 / 3)))
    expect(after.grudges[0]!.value).toBe(Math.round(before.grudges[0]!.value * (2 / 3)))
    expect(after.attachment).toBe(before.attachment)
  })

  it('replaying the same history gives the same feelings; leaving a fact out (a vetoed move) leaves no trace', () => {
    const base: FeelingFact[] = [start, ...games(5)]
    const vetoed = replayFeelings(DEFAULT_TRAITS, base)
    const moved = replayFeelings(DEFAULT_TRAITS, [...base, { kind: 'leave', teamId: 'a', asked: false }, { kind: 'arrive', teamId: 'b', how: 'moved' }])
    expect(replayFeelings(DEFAULT_TRAITS, base)).toEqual(vetoed)
    expect(vetoed.grudges).toEqual([])
    expect(moved.grudges).toHaveLength(1)
  })
})

describe('wanting out and belonging', () => {
  it('long unhappiness makes him want out; distrust makes it worse and attachment softer', () => {
    expect(wantingOut([], 0, 0)).toBe(0)
    expect(wantingOut([40, 30, 20], 0, 30)).toBe(0)
    const sour = wantingOut([-40, -45, -50], 0, 30)
    expect(sour).toBeGreaterThan(50)
    expect(wantingOut([-40, -45, -50], -60, 30)).toBeGreaterThan(sour)
    expect(wantingOut([-40, -45, -50], 0, 90)).toBeLessThan(sour)
  })

  it('belonging is trust and attachment, with 40 attachment as neutral', () => {
    expect(belonging(0, 40)).toBe(0)
    expect(belonging(50, 80)).toBeGreaterThan(50)
    expect(belonging(-100, 0)).toBe(-92)
  })
})
