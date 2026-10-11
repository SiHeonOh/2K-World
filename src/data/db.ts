import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

export type Db = DatabaseSync

export interface OpenOptions {
  /**
   * Called before migrations run on a database that already has a schema
   * (`from` ≥ 1), e.g. to keep a copy in the old format. Throwing stops the
   * upgrade, and the database isn't opened.
   */
  beforeMigrate?: (db: Db, from: number, to: number) => void
}

/** Opens (or creates) a league database and brings its schema up to date. */
export function openDb(file: string, options: OpenOptions = {}): Db {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
    const from = schemaVersion(db)
    if (options.beforeMigrate && from >= 1 && from < MIGRATIONS.length) options.beforeMigrate(db, from, MIGRATIONS.length)
    migrate(db)
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (e) {
    // An open handle keeps the file locked on Windows.
    db.close()
    throw e
  }
}

/**
 * SQL for a JSON column, NULL when it doesn't hold valid JSON: json_extract
 * and json_each throw on such a value, failing the whole statement over one
 * bad row (a job's input, an event's payload). A CASE, since SQLite may
 * test WHERE terms in any order.
 */
export const validJson = (column: string): string => `CASE WHEN json_valid(${column}) THEN ${column} END`

/** SQL for one field of a JSON column (`path` a literal such as '$.gameId'), NULL when the column isn't valid JSON. */
export function jsonField(column: string, path: string): string {
  if (!/^\$[\w.[\]]*$/.test(path)) throw new Error(`bad JSON path ${path}`)
  return `json_extract(${validJson(column)}, '${path}')`
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/**
 * Runs pending migrations. Foreign keys are off while they run (SQLite
 * ignores the pragma inside a transaction, and a table rebuild would
 * otherwise cascade-delete), and each step is checked before it commits.
 */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const current = schemaVersion(db)
  if (current > migrations.length) {
    throw new Error(`database schema v${current} is newer than this app (v${migrations.length})`)
  }
  if (current === migrations.length) return
  const fkWasOn = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (let v = current; v < migrations.length; v++) {
      transaction(db, () => {
        db.exec(migrations[v]!)
        const broken = db.prepare('PRAGMA foreign_key_check').all()
        if (broken.length > 0) throw new Error(`migration ${v + 1} broke ${broken.length} foreign key(s)`)
        db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON')
  }
}

let savepoints = 0

/**
 * Runs `fn` in one transaction; any throw rolls everything back. Nested calls
 * become savepoints, so helpers can wrap themselves and still compose.
 * `fn` must be synchronous: node:sqlite is synchronous, and an async body
 * would commit before its awaits finish.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const nested = db.isTransaction
  const savepoint = `sp${++savepoints}`
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (result instanceof Promise) throw new Error('transaction callbacks must be synchronous')
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
    return result
  } catch (e) {
    // SQLite may already have rolled back (e.g. on SQLITE_FULL); don't mask the real error.
    if (db.isTransaction) {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
      } else {
        db.exec('ROLLBACK')
      }
    }
    throw e
  }
}
