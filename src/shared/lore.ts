/**
 * The lore folder as the 로어 screen and its editor see it. The files are the
 * source of truth; main reads and writes them, the screen only sends edits.
 */

export type LoreKind = 'player' | 'team' | 'gm' | 'world'
export type LoreSectionKey = 'public' | 'rumor' | 'secret'
export type LoreSections = Record<LoreSectionKey, string>

/**
 * Why a lore file couldn't be used: outside teams/<학교>/ or world/, no ---
 * settings block, broken YAML, a setting with a wrong value, or unreadable.
 */
export type LoreErrorCode = 'not-in-folder' | 'no-settings' | 'yaml' | 'field' | 'unreadable'

export interface LoreErrorView {
  file: string
  /** 1-based; 0 when the problem isn't tied to a line. */
  line: number
  code: LoreErrorCode
  /** 'field': the setting's path, e.g. traits.usage ('' for the block as a whole). */
  field?: string
  /** The raw detail (from the YAML parser, the schema or the file system), untranslated. */
  message: string
}

// ── Settings, as the parser reads them (defaults filled in) ─────────────

export const PLAYER_TRAITS = ['ego', 'usage', 'competitiveness', 'loyalty', 'temperament', 'professionalism', 'ambition'] as const
export const GM_TRAITS = ['risk', 'patience', 'loyalty', 'star_chasing', 'defense_first', 'regional_pride', 'ego'] as const
export const RELATIONSHIP_TYPES = ['friend', 'rival', 'family', 'mentor', 'dislikes'] as const
export const VISIBILITIES = ['public', 'rumor', 'secret'] as const
export const MEDIA_STYLES = ['quiet', 'normal', 'outspoken'] as const
export const PHILOSOPHIES = ['win-now', 'balanced', 'development'] as const
export const NEGOTIATION_STYLES = ['fair', 'hardball', 'bluffer', 'pushover'] as const
export const WORLD_TYPES = ['topic', 'event', 'place', 'rivalry'] as const
export const MOOD_PARTS = ['role', 'usage', 'production', 'winning', 'recognition', 'relationships', 'rivalry', 'stability', 'belonging'] as const
/** Hook conditions the mood engine checks (src/story/mood.ts). Anything else in a file is kept but never fires. */
export const HOOK_TRIGGERS = ['traded', 'benched', 'losing_streak', 'winning_streak', 'award', 'rival_award', 'rival_ahead'] as const

export type PlayerTrait = (typeof PLAYER_TRAITS)[number]
export type GmTrait = (typeof GM_TRAITS)[number]
export type MoodPartKey = (typeof MOOD_PARTS)[number]

export interface LoreRelationship {
  with: string
  type: (typeof RELATIONSHIP_TYPES)[number]
  strength: number
  visibility: (typeof VISIBILITIES)[number]
}

export interface LoreHook {
  when: string
  /** rival_award: whose award (a name, or 이름(학교)); any rival when left out. */
  rival?: string
  mood: Partial<Record<MoodPartKey, number>>
}

export interface PlayerLoreSettings {
  id: string
  traits: Record<PlayerTrait, number>
  media: (typeof MEDIA_STYLES)[number]
  relationships: LoreRelationship[]
  hooks: LoreHook[]
  canon: boolean
}

export interface TeamLoreSettings {
  id: string
  colors: string[]
  fans: { size: number; temperament: number; pride: number }
  rivals: string[]
  canon: boolean
}

export interface GmLoreSettings {
  id: string
  name: string | null
  team: string
  philosophy: (typeof PHILOSOPHIES)[number]
  traits: Record<GmTrait, number>
  negotiation: (typeof NEGOTIATION_STYLES)[number]
  relationships: LoreRelationship[]
  canon: boolean
}

export interface WorldLoreSettings {
  id: string
  type: (typeof WORLD_TYPES)[number]
  date: string | null
  involves: string[]
  canon: boolean
}

export type LoreEditableView =
  | { kind: 'player'; settings: PlayerLoreSettings; sections: LoreSections }
  | { kind: 'team'; settings: TeamLoreSettings; sections: LoreSections }
  | { kind: 'gm'; settings: GmLoreSettings; sections: LoreSections }
  | { kind: 'world'; settings: WorldLoreSettings; sections: LoreSections }

// ── The index (the list on the left) ────────────────────────────────────

/** What a file belongs to in the league. */
export type LoreLink = { kind: 'player'; playerId: string; teamId: string } | { kind: 'team' | 'gm'; teamId: string } | { kind: 'world' }

export interface LoreFileView {
  file: string
  kind: LoreKind
  /** The team or player it belongs to, or null when nothing matched. */
  linkedTo: string | null
  link: LoreLink | null
  /** Characters per section; 0 = empty. */
  sizes: Record<LoreSectionKey, number>
}

export interface LoreIndexView {
  folder: string
  exists: boolean
  files: LoreFileView[]
  errors: LoreErrorView[]
  /** Players without a lore file. */
  missing: { id: string; name: string; teamId: string }[]
  /** Teams without a school file, and without a GM file. */
  missingTeams: string[]
  missingGms: string[]
  /**
   * Player files still outside their player's team folder (they're used all
   * the same). taken: a different file already has that name there.
   */
  misplaced: { file: string; to: string; taken: boolean }[]
  /** Players more than one file points at; `kept` is the one used (in his team's folder), or null when none is. */
  duplicates: { name: string; files: string[]; kept: string | null }[]
  /** Where each traded player started (for 이름(학교) references); players never moved aren't listed. */
  firstTeams: Record<string, string>
  /** This league and no other (its folder and when it was made): unsaved drafts are kept under it. */
  draftScope: string
}

// ── One file in the editor ──────────────────────────────────────────────

export interface LoreBackupView {
  id: string
  /** ISO time it was taken (just before a save replaced it). */
  at: string
  size: number
}

export interface LoreDocView {
  file: string
  kind: LoreKind
  /** The file's text exactly as it is on disk. */
  text: string
  /** Changes whenever the text does; raw saves are refused if it moved on. */
  version: string
  /** False when the file isn't UTF-8: it's shown, but never saved over (its text would be lost). */
  utf8: boolean
  /** The form's starting point; null when the settings block can't be read (only the raw view then). */
  editable: LoreEditableView | null
  errors: LoreErrorView[]
  /** Sections written under more than one heading: those are edited in the raw view. */
  splitSections: LoreSectionKey[]
  backups: LoreBackupView[]
}

export type LoreSaveInput =
  /** overwrite: where the file changed elsewhere too, the editor's version wins (everything else is still kept). */
  | { mode: 'form'; file: string; base: LoreEditableView; next: LoreEditableView; overwrite?: boolean }
  | { mode: 'raw'; file: string; version: string; text: string; force?: boolean }

export type LoreSaveError = 'heading-in-text' | 'split-section' | 'comments-in-section' | 'unverified' | 'invalid' | 'no-settings' | 'not-utf8'

export type LoreSaveResult =
  /** merged: the file had changed elsewhere, and those changes were kept. */
  | { status: 'saved'; doc: LoreDocView; merged: boolean }
  | { status: 'unchanged'; doc: LoreDocView }
  /** Both sides changed these fields; nothing was written. `doc` is the file as it is now. */
  | { status: 'conflict'; fields: string[]; doc: LoreDocView }
  /** Raw save: the file changed since it was loaded. */
  | { status: 'changed'; doc: LoreDocView }
  /** Raw save: the text has problems; save again with `force` to keep it anyway. */
  | { status: 'invalid'; errors: LoreErrorView[] }
  /** The file is gone (moved or deleted). */
  | { status: 'gone' }
  | { status: 'error'; code: LoreSaveError; detail: string }

// ── The tables (many files' settings on one screen) ───────────────────

/** One player, GM or school in a table: its file's settings, or nothing yet. */
export interface LoreTableRow {
  kind: 'player' | 'gm' | 'team'
  teamId: string
  playerId?: string
  /** Null: no file yet (saving an edit makes one from the template). */
  file: string | null
  /** The file's form data; null when there's no file, or it can't be read (`broken`). */
  editable: LoreEditableView | null
  broken: boolean
  sizes: Record<LoreSectionKey, number> | null
}

export interface LoreTableView {
  draftScope: string
  rows: LoreTableRow[]
}

export type LoreCreateTarget =
  | { kind: 'player'; playerId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'gm'; teamId: string }
  | { kind: 'world'; title: string }
