import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb } from '@data/db'
import { currentSeason, seedLeague } from '@data/league'
import { listGames, startSeason } from '@data/season'
import { gamesReadWith, latestScreenshots } from './gameday'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('latestScreenshots', () => {
  it('takes the newest images from the last few hours, newest first, skipping folders and other files', () => {
    const dir = mkdtempSync(join(tmpdir(), '2kw-shots-'))
    dirs.push(dir)
    const now = Date.now()
    const put = (name: string, minutesAgo: number) => {
      writeFileSync(join(dir, name), name)
      const t = (now - minutesAgo * 60_000) / 1000
      utimesSync(join(dir, name), t, t)
    }
    put('old.png', 60 * 24)
    put('a.jpg', 30)
    put('b.png', 10)
    put('c.PNG', 5)
    put('notes.txt', 1)
    mkdirSync(join(dir, 'thumbnails.png'))
    expect(latestScreenshots(dir, 2, now).map((f) => f.name)).toEqual(['c.PNG', 'b.png'])
    expect(latestScreenshots(dir, 4, now).map((f) => f.name)).toEqual(['c.PNG', 'b.png', 'a.jpg'])
    expect(new TextDecoder().decode(latestScreenshots(dir, 1, now)[0]!.bytes)).toBe('c.PNG')
    expect(() => latestScreenshots(join(dir, 'missing'), 2, now)).toThrow()
  })
})

describe('gamesReadWith', () => {
  it('passes over a reading whose stored input isn’t JSON', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    startSeason(db)
    const game = listGames(db, currentSeason(db).id)[0]!
    const job = db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('read_box_score', ?, 50, ?, 'now')")
    job.run('failed', 'not json {')
    job.run('done', JSON.stringify({ gameId: game.id, hashes: ['a'] }))
    expect(gamesReadWith(db, ['a'], -1).map((g) => g.id)).toEqual([game.id])
    db.close()
  })
})
