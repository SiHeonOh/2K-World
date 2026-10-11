import type { Traits } from './mood'

/**
 * Lasting feelings, in plain code: trust in his GM, attachment to his
 * school, grudges, and (worked out from those and his recent moods) how much
 * he wants out. They're never stored and nudged: each time, the player's
 * history is replayed from the start, each happening fading slowly. So a
 * corrected score, a vetoed move or a removed award changes the replay, and
 * the feelings fix themselves the way moods do.
 */

/** Something that happened to one player, in order. Team ids; names only for the reasons shown. */
export type FeelingFact =
  /** A new season began: trust and grudges keep two thirds; attachment carries over. */
  | { kind: 'season' }
  /** He joined a school: at the league's start, by a trade he asked for, picked in the draft, or moved without asking. */
  | { kind: 'arrive'; teamId: string; how: 'start' | 'requested' | 'drafted' | 'moved' }
  /** He left a school; without asking, it leaves a grudge (a smaller one when he was only taken in the draft). */
  | { kind: 'leave'; teamId: string; asked: boolean; taken?: boolean }
  /** One of his school's games. */
  | { kind: 'game'; won: boolean; benched: boolean }
  /** His GM sent away (or brought in) a friend of his; `secret` when the tie is a secret one. */
  | { kind: 'friend'; name: string; strength: number; joined: boolean; secret?: boolean }
  /** His trade request outlived a trade window. */
  | { kind: 'ignored'; public: boolean }
  /** Talks in which this school offered him leaked. It counts only while he's still there. */
  | { kind: 'shopped'; teamId: string }
  /** His GM made the team clearly stronger (+) or sold off (−), in value points. */
  | { kind: 'deal'; gain: number }
  | { kind: 'series' }
  | { kind: 'award'; season: boolean; name: string }
  /** Someone jabbed at him in public. */
  | { kind: 'called_out'; byId: string }

export type TrustKey = 'arrival' | 'results' | 'bench' | 'friend_left' | 'friend_joined' | 'ignored_private' | 'ignored_public' | 'shopped' | 'deal'
export type AttachmentKey = 'start' | 'games' | 'results' | 'success' | 'friend_left' | 'shopped'
export type GrudgeWhy = 'sent_away' | 'called_out'

export interface FeelingReason<K extends string> {
  key: K
  /** A friend's name, or an award's. */
  name?: string
  /** The name is a secret tie's. */
  secret?: boolean
  /** What's left of it now (signed). */
  value: number
}

export interface Grudge {
  target: { kind: 'team' | 'player'; id: string }
  value: number
  why: GrudgeWhy
  /** His school's games since it began. */
  games: number
}

export interface Feelings {
  /** −100..+100, toward the GM of the school he's at now. */
  trust: number
  /** 0..100, to the school he's at now. */
  attachment: number
  grudges: Grudge[]
  /** The biggest parts of each, strongest first. */
  why: { trust: FeelingReason<TrustKey>[]; attachment: FeelingReason<AttachmentKey>[] }
}

/** The numbers behind the feelings, in one place. */
export const FEELING_RULES = {
  /** Trust fades by half over this many of his school's games; grudges over this many. */
  trustHalfLife: 12,
  grudgeHalfLife: 30,
  /** What a new season keeps of trust and grudges. */
  seasonCarry: 2 / 3,
  arrival: { start: 0, requested: 20, drafted: 10, moved: 0 },
  friendLeft: -5,
  friendJoined: 3,
  ignored: { private: -15, public: -25 },
  shopped: -10,
  bench: -2.5,
  win: 1,
  loss: -0.5,
  /** Attachment: a game together, by loyalty; a win or a loss on top. */
  gameBase: 0.3,
  gamePerLoyalty: 0.1,
  winTogether: 0.3,
  lossTogether: -0.2,
  seriesWon: 5,
  seasonAward: 8,
  periodicAward: 2,
  /** Attachment at arrival: 10 per point of loyalty plus this (40 for an average player, 0 belonging); less if moved without asking. */
  startBase: 10,
  movedStart: -10,
  /** Being taken in the draft stings less than being traded away: this share of the grudge. */
  takenShare: 0.5,
  /** Attachment lost per point of a departed friend's strength, and to being shopped. */
  friendLeftAttachment: -3,
  shoppedAttachment: -5,
  /** A grudge when sent away: this much, plus a share of the attachment he lost. */
  sentAway: -15,
  sentAwayPerAttachment: -0.25,
  calledOut: -15,
} as const

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round = (v: number) => Math.round(v * 10) / 10
/** Ego (or another trait) as a 0.8..1.6 multiplier: 3 is 1.2. */
const by = (trait: number) => 0.6 + trait / 5

export function replayFeelings(traits: Traits, facts: FeelingFact[]): Feelings {
  const R = FEELING_RULES
  const trustFade = 0.5 ** (1 / R.trustHalfLife)
  const grudgeFade = 0.5 ** (1 / R.grudgeHalfLife)
  // Trust: what's left of each reason (they fade); attachment: running totals per reason (they don't).
  let trust = new Map<string, FeelingReason<TrustKey>>()
  let attachment = new Map<string, FeelingReason<AttachmentKey>>()
  const grudges = new Map<string, Grudge>()
  // The school he's at as the replay goes.
  let here: string | undefined
  const addTrust = (key: TrustKey, value: number, name?: string, secret?: boolean) => {
    const id = name ? `${key}:${name}` : key
    const had = trust.get(id)
    trust.set(id, { key, ...(name ? { name } : {}), ...(secret ? { secret } : {}), value: (had?.value ?? 0) + value })
  }
  const addAttachment = (key: AttachmentKey, value: number, name?: string) => {
    const had = attachment.get(key)
    attachment.set(key, { key, ...(name ? { name } : {}), value: (had?.value ?? 0) + value })
  }
  const attachmentNow = () => clamp([...attachment.values()].reduce((s, r) => s + r.value, 0), 0, 100)
  const addGrudge = (kind: 'team' | 'player', id: string, value: number, why: GrudgeWhy) => {
    const key = `${kind}:${id}`
    const had = grudges.get(key)
    grudges.set(key, { target: { kind, id }, value: (had?.value ?? 0) + value, why: had && had.value < value ? had.why : why, games: had?.games ?? 0 })
  }

  for (const f of facts) {
    switch (f.kind) {
      case 'season':
        for (const r of trust.values()) r.value *= R.seasonCarry
        for (const g of grudges.values()) g.value *= R.seasonCarry
        break
      case 'arrive':
        here = f.teamId
        trust = new Map()
        attachment = new Map()
        if (R.arrival[f.how]) addTrust('arrival', R.arrival[f.how])
        addAttachment('start', 10 * traits.loyalty + R.startBase + (f.how === 'moved' ? R.movedStart : 0))
        break
      case 'leave':
        if (!f.asked) addGrudge('team', f.teamId, (R.sentAway + R.sentAwayPerAttachment * attachmentNow()) * (f.taken ? R.takenShare : 1), 'sent_away')
        break
      case 'game':
        for (const r of trust.values()) r.value *= trustFade
        for (const g of grudges.values()) {
          g.value *= grudgeFade
          g.games++
        }
        addTrust('results', (f.won ? R.win : R.loss) * (traits.competitiveness / 3))
        if (f.benched) addTrust('bench', R.bench * (traits.ego / 3))
        addAttachment('games', R.gameBase + R.gamePerLoyalty * traits.loyalty)
        addAttachment('results', f.won ? R.winTogether : R.lossTogether)
        break
      case 'friend':
        if (f.joined) addTrust('friend_joined', R.friendJoined * f.strength, f.name, f.secret)
        else {
          addTrust('friend_left', R.friendLeft * f.strength, f.name, f.secret)
          addAttachment('friend_left', R.friendLeftAttachment * f.strength)
        }
        break
      case 'ignored':
        addTrust(f.public ? 'ignored_public' : 'ignored_private', f.public ? R.ignored.public : R.ignored.private)
        break
      case 'shopped':
        // A school he's left by the time it leaks took the slight with it: trust and attachment
        // started over at his new school, and being sent away left its own grudge.
        if (f.teamId !== here) break
        addTrust('shopped', R.shopped)
        addAttachment('shopped', R.shoppedAttachment)
        break
      case 'deal':
        addTrust('deal', clamp((f.gain / 2) * (traits.competitiveness / 3), -10, 10))
        break
      case 'series':
        addAttachment('success', R.seriesWon)
        break
      case 'award':
        addAttachment('success', f.season ? R.seasonAward : R.periodicAward)
        break
      case 'called_out':
        addGrudge('player', f.byId, R.calledOut * by(traits.ego) / 1.2, 'called_out')
        break
    }
    // Attachment stays within 0..100 as it goes, so a long stay can't bank more than a full heart.
    const total = [...attachment.values()].reduce((s, r) => s + r.value, 0)
    if (total > 100) addAttachment('games', 100 - total)
    else if (total < 0) addAttachment('start', -total)
  }

  const strongest = <K extends string>(list: FeelingReason<K>[]) =>
    list
      .map((r) => ({ ...r, value: round(r.value) }))
      .filter((r) => Math.abs(r.value) >= 1)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 4)
  return {
    trust: Math.round(clamp([...trust.values()].reduce((s, r) => s + r.value, 0), -100, 100)),
    attachment: Math.round(attachmentNow()),
    grudges: [...grudges.values()]
      .map((g) => ({ ...g, value: Math.round(clamp(g.value, -100, 0)) }))
      .filter((g) => g.value <= -3)
      .sort((a, b) => a.value - b.value),
    why: { trust: strongest([...trust.values()]), attachment: strongest([...attachment.values()]) },
  }
}

/**
 * How much he wants out (0..100): how unhappy he's been over his last few
 * mood snapshots (a mood of 0 or better counts nothing, the 불만 line counts
 * 0.4, 폭발 직전 fully), made worse by distrust and softened by attachment.
 */
export function wantingOut(recentOverall: number[], trust: number, attachment: number): number {
  if (recentOverall.length === 0) return 0
  const unhappy = recentOverall.reduce((s, o) => s + clamp(-o / 50, 0, 1.2), 0) / recentOverall.length
  return Math.round(100 * clamp(unhappy * (1 + Math.max(0, -trust) / 100) * (1 - attachment / 150), 0, 1))
}

/** The ninth mood part, 소속감: trust in his GM and attachment to his school (40 is neutral). */
export function belonging(trust: number, attachment: number): number {
  return Math.round(clamp(0.6 * trust + 0.8 * (attachment - 40), -100, 100))
}
