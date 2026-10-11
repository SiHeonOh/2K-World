/**
 * Backups of a league: copies of its database in <league>/backups, and
 * snapshots of its lore folder in <league>/backups/lore-snapshots.
 */

/** A copy of the league database. */
export interface BackupView {
  /** The file name, which a restore names. */
  id: string
  /** When it was made (ISO, UTC). */
  at: string
  /**
   * Why: 'manual' (지금 백업), 'open', 'upgrade-v<N>' (before the app upgraded a
   * schema-v<N> database), 'before-restore', or the step it was made before
   * ('season-start', 'draft-swap', 'config', …).
   */
  reason: string
  bytes: number
  /** The latest season in it; null when the file doesn't read. */
  season: string | null
  /** Its schema version (an older one is upgraded when restored); null when the file doesn't read. */
  version: number | null
  /** False for a file that isn't a league this app can open (damaged, or from a newer app): it can't be restored. */
  restorable: boolean
  /** How many of its kind are kept; null: never removed by the app. */
  keep: number | null
}

/** A copy of the lore folder. */
export interface LoreSnapshotView {
  id: string
  at: string
  reason: string
  files: number
  bytes: number
  keep: number | null
}

export interface BackupsView {
  db: BackupView[]
  lore: LoreSnapshotView[]
  /** The league has a lore folder (snapshots are only made when it does). */
  hasLore: boolean
  /** This app's schema version: a backup below it is upgraded when restored. */
  schema: number
}

/** A school's lore folder (and its school, GM and same-name players' files) moved to the school's name in the database. */
export interface SchoolFolderMove {
  from: string
  to: string
}

export interface RestoreResult {
  /** The backup of what was there before (reason 'before-restore'). */
  safety: string
  /** The backup was from an older app: its database was upgraded (after an 'upgrade' copy). */
  upgraded: boolean
  /**
   * Schools renamed since the backup: their lore folders went back to the
   * names the restored league uses (only into names no folder had).
   */
  schools: SchoolFolderMove[]
}

export interface LoreRestoreResult {
  /** The snapshot of the lore folder as it was (reason 'before-restore'); null when there was none. */
  safety: string | null
  /** Player files moved into their current teams' folders afterwards. */
  moved: number
  /** Folders of schools renamed since the snapshot, moved to their names now (only into names no folder had). */
  schools: SchoolFolderMove[]
  /**
   * The folder the restore replaced, when it had to stay: something in it
   * isn't in the 'before-restore' snapshot and couldn't be moved into the
   * restored folder (its name was taken there, or it was locked). Null when
   * it was removed.
   */
  kept: string | null
}

/** The kind a reason belongs to: an upgrade's reason names the version it upgraded from. */
export const backupKind = (reason: string): string => (/^upgrade-v\d+$/.test(reason) ? 'upgrade' : reason)
