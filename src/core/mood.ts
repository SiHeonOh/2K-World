/**
 * Player mood, in plain code. Eight parts, each −100..+100, from what
 * happened (role, shots, production, results, awards, teammates, rivals,
 * moves), weighted by the player's traits into one overall number and a
 * band. The AI only speaks for a player when the band changes or something
 * big happens; it never decides the numbers.
 */

export const MOOD_PARTS = ['role', 'usage', 'production', 'winning', 'recognition', 'relationships', 'rivalry', 'stability', 'belonging'] as const
export type MoodPart = (typeof MOOD_PARTS)[number]

export type MoodBand = 'happy' | 'content' | 'neutral' | 'unhappy' | 'boiling'

/** 1..5 each, 3 = average. */
export interface Traits {
  ego: number
  usage: number
  competitiveness: number
  loyalty: number
  temperament: number
  professionalism: number
  ambition: number
}

export const DEFAULT_TRAITS: Traits = { ego: 3, usage: 3, competitiveness: 3, loyalty: 3, temperament: 3, professionalism: 3, ambition: 3 }

export interface MoodInput {
  traits: Traits
  /** In a starter slot now. */
  starter: boolean
  /** Good enough to start, by the team's pecking order. */
  expectsToStart: boolean
  /** His share of the team's possessions over the last few games, or null with no box scores yet. */
  usageShare: number | null
  expectedShare: number
  /** Points per game over the same games, and what his value suggests. */
  points: number | null
  expectedPoints: number
  /** The team's win share this season (null before any game) and its streak (+3 = won three). */
  winPct: number | null
  streak: number
  /** Awards this season (selections count half). */
  awards: number
  /** Late enough in the season that a star without an award notices. */
  seasonMature: boolean
  isStar: boolean
  friendsOnTeam: number
  rivalsOnTeam: number
  /** Friends traded away recently, weighted by how recently (0..n). */
  friendsLost: number
  /** −1..1: named rivals doing worse (−) or better (+) than him. */
  rivalEdge: number
  /** Trades or swaps involving him, weighted by how recently (0..n). */
  recentMoves: number
  /** 소속감 from his lasting feelings (trust in his GM, attachment to his school): src/core/feelings.ts. */
  belonging: number
  /** Extra points from his lore's hooks, per part. */
  hooks: Partial<Record<MoodPart, number>>
  /** 0..1, seeded: a little noise, more for hot tempers. */
  noise: number
}

export interface Mood {
  parts: Record<MoodPart, number>
  overall: number
  band: MoodBand
  /** The parts that move him most, strongest first (signed, weighted). */
  reasons: { part: MoodPart; value: number }[]
}

const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)))

/** How much each part counts for this player. */
export function weights(t: Traits): Record<MoodPart, number> {
  return {
    role: 0.5 + t.ego / 5,
    usage: 0.4 + (t.usage + t.ego) / 10,
    production: 0.5 + t.ambition / 5,
    winning: 0.5 + t.competitiveness / 5,
    recognition: 0.3 + t.ambition / 5,
    relationships: 0.3 + t.loyalty / 5,
    rivalry: 0.2 + (t.ambition + t.ego) / 10,
    // Professionals shrug off being moved around.
    stability: 0.3 + (6 - t.professionalism) / 5,
    // Loyal players care most whether they belong.
    belonging: 0.3 + t.loyalty / 5,
  }
}

export function band(overall: number): MoodBand {
  if (overall >= 45) return 'happy'
  if (overall >= 15) return 'content'
  if (overall > -20) return 'neutral'
  if (overall > -50) return 'unhappy'
  return 'boiling'
}

export function computeMood(i: MoodInput): Mood {
  const t = i.traits
  const role = i.starter ? (i.expectsToStart ? 35 : 60) : i.expectsToStart ? -30 - 12 * t.ego : 5
  const usage = i.usageShare === null ? 0 : (i.usageShare - i.expectedShare) * 500 * (0.6 + t.usage / 5)
  const production = i.points === null ? 0 : ((i.points - i.expectedPoints) / Math.max(4, i.expectedPoints)) * 120
  const winning = i.winPct === null ? 0 : (i.winPct - 0.5) * 150 + Math.max(-5, Math.min(5, i.streak)) * 7
  const recognition = Math.min(100, i.awards * 45) - (i.isStar && i.seasonMature && i.awards === 0 ? 25 : 0)
  const relationships = i.friendsOnTeam * 25 - i.rivalsOnTeam * 30 - i.friendsLost * 35
  const rivalry = -i.rivalEdge * 60
  const stability = -i.recentMoves * 45
  const base: Record<MoodPart, number> = { role, usage, production, winning, recognition, relationships, rivalry, stability, belonging: i.belonging }
  const parts = Object.fromEntries(MOOD_PARTS.map((p) => [p, clamp(base[p] + (i.hooks[p] ?? 0))])) as Record<MoodPart, number>
  const w = weights(t)
  // 소속감 adds to the others rather than sharing their average: with none either way, moods are as before.
  const total = MOOD_PARTS.filter((p) => p !== 'belonging').reduce((s, p) => s + w[p], 0)
  const noise = (i.noise - 0.5) * t.temperament * 4
  const overall = clamp(MOOD_PARTS.reduce((s, p) => s + parts[p] * w[p], 0) / total + noise)
  const reasons = MOOD_PARTS.map((p) => ({ part: p, value: Math.round(parts[p] * w[p]) }))
    .filter((r) => Math.abs(r.value) >= 10)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  return { parts, overall, band: band(overall), reasons }
}

/** Two ball-hungry players on one team who both feel short of shots: a feud in the making. */
export function usageClashes(players: { id: string; traits: Traits; mood: Mood }[]): [string, string][] {
  const hungry = players.filter((p) => p.traits.usage >= 4 && p.mood.parts.usage <= -20)
  const out: [string, string][] = []
  for (let a = 0; a < hungry.length; a++) for (let b = a + 1; b < hungry.length; b++) out.push([hungry[a]!.id, hungry[b]!.id])
  return out
}
