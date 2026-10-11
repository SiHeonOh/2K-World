import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { knownErrorCode } from '@shared/dbErrors'
import { openDb } from '@data/db'
import { peekLeague } from '@data/league'
import { MIGRATIONS } from '@data/migrations'
import { AppError, errorShape } from './errors'

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

describe('errors as the screens get them', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '2kw-errors-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  it('passes an AppError through as it is; anything unknown stays internal, with its text', () => {
    expect(errorShape(new AppError('not-found', 'job 3'))).toEqual({ code: 'not-found', message: 'job 3' })
    expect(errorShape(new Error('x is undefined'))).toEqual({ code: 'internal', message: 'x is undefined' })
    expect(errorShape('plain')).toEqual({ code: 'internal', message: 'plain' })
  })

  it('a league saved by a newer app: opening it and listing it both say so', () => {
    const file = join(dir, 'league.sqlite')
    const raw = new DatabaseSync(file)
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`)
    raw.close()
    expect(errorShape(thrown(() => openDb(file)))).toMatchObject({ code: 'db-too-new', message: expect.stringContaining('newer than this app') })
    expect(knownErrorCode((thrown(() => peekLeague(file)) as Error).message)).toBe('db-too-new')
  })

  it('a clash with a stored row, as node:sqlite reports it', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('가람고')
    const e = thrown(() => db.prepare('INSERT INTO t (name) VALUES (?)').run('가람고'))
    db.close()
    expect(errorShape(e)).toMatchObject({ code: 'db-constraint', message: expect.stringContaining('UNIQUE constraint failed') })
  })

  it('a file that is not a league at all', () => {
    const file = join(dir, 'league.sqlite')
    writeFileSync(file, 'this is a text file someone renamed, not a database '.repeat(20))
    expect(errorShape(thrown(() => openDb(file)))).toMatchObject({ code: 'db-corrupt' })
  })

  it('a busy file, a full disk, a damaged file, by their words', () => {
    expect(knownErrorCode('database is locked')).toBe('db-busy')
    expect(knownErrorCode("EBUSY: resource busy or locked, rename 'C:\\leagues\\x'")).toBe('db-busy')
    expect(knownErrorCode('database or disk is full')).toBe('disk-full')
    expect(knownErrorCode('ENOSPC: no space left on device, write')).toBe('disk-full')
    expect(knownErrorCode('database disk image is malformed')).toBe('db-corrupt')
    expect(knownErrorCode('not a league database')).toBe('db-corrupt')
    expect(knownErrorCode('something else')).toBeNull()
    // SQLite's own words in errstr count too.
    expect(errorShape(Object.assign(new Error('SQL error'), { errstr: 'database is locked' }))).toMatchObject({ code: 'db-busy', message: 'SQL error' })
  })
})
