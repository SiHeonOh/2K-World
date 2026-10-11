import type { LeagueConfig, Phase } from './config/schema'
import { isFolderSafe, type Player, type Team } from './setup'

/** League folder names: letters (any script), digits, - and _. No dots, so no path tricks. */
export const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,59}$/u
const RESERVED_SLUGS = new Set(['templates', 'backups', 'settings'])

export function isValidSlug(slug: string): boolean {
  // isFolderSafe also refuses Windows device names (con, nul, com1…).
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug.toLowerCase()) && isFolderSafe(slug)
}

/** Windows folders ignore case: one key per folder. */
export const slugKey = (slug: string) => slug.normalize('NFC').toLowerCase()

/** A folder-name suggestion from a league name. */
export function suggestSlug(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 60)
}

export interface SeasonInfo {
  id: number
  label: string
  phase: Phase
  /** Seeds everything the engine draws this season (schedule order, coin flips). */
  seed: string
}

/** A season for the screens' season pickers. Only the newest one is current; the rest are over and read only. */
export interface SeasonListing {
  id: number
  label: string
  current: boolean
}

/** A league folder in the data folder, as the home screen lists it. */
export interface LeagueListing {
  slug: string
  /** Null when the folder has no league database yet (e.g. lore only). */
  name: string | null
  hasDb: boolean
  hasLore: boolean
  teams: number
  players: number
  season: string | null
  /** Set when the database exists but can't be read. */
  error?: string
}

export interface PlayerRow extends Player {
  heightCm: number | null
}

/** Everything the League Office screens need to draw rosters. */
export interface LeagueSnapshot {
  slug: string
  config: LeagueConfig
  configVersion: number
  season: SeasonInfo
  /** Every season, oldest first; the last one is `season`. */
  seasons: SeasonListing[]
  teams: Team[]
  players: PlayerRow[]
  /** The newest roster- or settings-changing event when this was read ('leagues.stamp' moves past it when it's stale). */
  stamp: number
}

/** What the setup wizard learns about a target folder before creating a league there. */
export interface FolderInspection {
  slug: string
  exists: boolean
  hasDb: boolean
  /** Team folder names found under lore/teams/. */
  loreTeams: string[]
}
