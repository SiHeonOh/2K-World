import type { ErrorCode } from './api'

/**
 * Database and disk errors the user can do something about, told by their
 * (English) text, so the screens can say them in Korean. Null for anything
 * else. Shared: the main process maps failed calls with it, and the league
 * list maps a league file it couldn't read.
 */
export function knownErrorCode(message: string): ErrorCode | null {
  // Thrown by migrate() and peekLeague() for a league saved by a newer app.
  if (/\bschema v\d+ is newer than this app\b/i.test(message)) return 'db-too-new'
  if (/\b(database or disk is full|SQLITE_FULL|ENOSPC|no space left on device)\b/i.test(message)) return 'disk-full'
  if (/\b(database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|EBUSY|resource busy or locked)\b/i.test(message)) return 'db-busy'
  if (/\b(file is not a database|database disk image is malformed|SQLITE_CORRUPT|SQLITE_NOTADB|not a league database)\b/i.test(message)) return 'db-corrupt'
  if (/\bconstraint failed\b|\bSQLITE_CONSTRAINT/i.test(message)) return 'db-constraint'
  return null
}
