import type { LeagueConfig } from './config/schema'
import type { RatingValue } from './setup'

/** One player's roster facts to change; fields left out stay as they are. */
export interface PlayerEdit {
  playerId: string
  name?: string
  height?: string
  nicknames?: string[]
  notes?: string
  /** Only the columns that change; null clears one. */
  ratings?: Record<string, RatingValue>
  /** His slot on his own team (made in 2K first); null leaves him without one ('free' leagues only). */
  slotId?: string | null
}

export interface RosterChange {
  playerId: string
  teamId: string
  /** What changed: name, height, nicknames, notes, ratings.<column>, slot. */
  fields: string[]
  renamedFrom: string | null
}

/** What a rename took along, and what's left for you. */
export interface RenameResult {
  playerId: string
  from: string
  to: string
  /** His lore file, renamed to match (null: he has none). `failed`: it couldn't be renamed (locked?), so it stayed. */
  lore: { from: string; to: string; status: 'moved' | 'failed' } | null
  /** His wiki page's new title, or null when it kept the old one (none yet, or the new title is another page's). */
  wikiTitle: string | null
  /** Other lore files (relationships, rules, topics) and wiki pages still using the old name: yours to update. */
  loreReferences: string[]
  wikiLinks: number
  /** The new name is another school's player's too: files naming it without a school in brackets are now ambiguous. */
  sharedName: boolean
  ambiguousReferences: string[]
}

export interface RosterSaveResult {
  changed: number
  renamed: RenameResult[]
}

type RosterRules = LeagueConfig['roster']

/** What's wrong with one team's roster: its size, or (in 'one-per-slot') a slot held by other than exactly one player. */
export type RosterProblem = { kind: 'size'; count: number } | { kind: 'slot'; slotId: string; slot: string; count: number }

/**
 * One team's roster, as each player's slot, against the league's roster
 * rules. Trades, roster edits and the editor's live check all go by it.
 */
export function rosterProblems(roster: RosterRules, slots: readonly (string | null)[]): RosterProblem[] {
  const out: RosterProblem[] = []
  if (slots.length < roster.minPlayers || slots.length > roster.maxPlayers) out.push({ kind: 'size', count: slots.length })
  if (roster.slotMode === 'one-per-slot') {
    for (const s of roster.slots) {
      const n = slots.filter((x) => x === s.id).length
      if (n !== 1) out.push({ kind: 'slot', slotId: s.id, slot: s.name, count: n })
    }
  }
  return out
}

/**
 * A slot change that moves him between the starters and the bench (a role
 * change: moods and the news care), or null when his role stays.
 */
export function rotationMove(roster: RosterRules, from: string | null, to: string | null): 'up' | 'down' | null {
  const starter = (id: string | null) => roster.slots.find((s) => s.id === id)?.starter ?? false
  if (starter(from) === starter(to)) return null
  return starter(to) ? 'up' : 'down'
}
