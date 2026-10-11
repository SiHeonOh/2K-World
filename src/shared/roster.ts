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
}

export interface RosterChange {
  playerId: string
  teamId: string
  /** What changed: name, height, nicknames, notes, ratings.<column>. */
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
