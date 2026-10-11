import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { migrate, openDb, schemaVersion, transaction } from './db'
import { MIGRATIONS } from './migrations'
import { currentSeason, listEvents, listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from './league'
import { SetupError } from '@shared/setup'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), '2kw-'))
  dirs.push(dir)
  return join(dir, 'league.sqlite')
}

describe('database', () => {
  it('migrates a new file to the latest schema', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    db.close()
  })

  it('refuses a database from a newer app', () => {
    const db = openDb(':memory:')
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    expect(() => migrate(db)).toThrow(/newer/)
    db.close()
  })

  it('nests transactions as savepoints', () => {
    const db = openDb(':memory:')
    const insert = (label: string) =>
      db.prepare("INSERT INTO seasons (label, phase, started_at) VALUES (?, 'preseason', 'now')").run(label)
    transaction(db, () => {
      insert('outer')
      expect(() =>
        transaction(db, () => {
          insert('inner')
          throw new Error('inner fails')
        }),
      ).toThrow('inner fails')
      transaction(db, () => insert('inner ok'))
    })
    expect(db.prepare('SELECT label FROM seasons ORDER BY id').all()).toEqual([{ label: 'outer' }, { label: 'inner ok' }])
    db.close()
  })

  it('refuses async callbacks and rolls them back', () => {
    const db = openDb(':memory:')
    expect(() =>
      transaction(db, async () => {
        db.exec("INSERT INTO seasons (label, phase, started_at) VALUES ('x', 'preseason', 'now')")
      }),
    ).toThrow(/synchronous/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM seasons').get()).toEqual({ n: 0 })
    expect(db.isTransaction).toBe(false)
    db.close()
  })

  it('runs migrations with foreign keys off, so table rebuilds keep child rows', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    // The usual SQLite table rebuild: new table, copy, drop old, rename.
    const rebuild = `
      CREATE TABLE players_new (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams (id), name TEXT NOT NULL,
        slot_id TEXT, height TEXT NOT NULL DEFAULT '', height_cm REAL,
        nicknames TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL
      );
      INSERT INTO players_new SELECT * FROM players;
      DROP TABLE players;
      ALTER TABLE players_new RENAME TO players;`
    migrate(db, [...MIGRATIONS, rebuild])
    expect((db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n).toBe(96)
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    db.close()
  })

  it('rebuilds the suggestion inbox to take secret reveals, keeping every card and index', () => {
    const db = new DatabaseSync(':memory:')
    const reveals = MIGRATIONS.findIndex((m) => m.includes("'fact', 'reveal'"))
    expect(reveals).toBeGreaterThan(7)
    migrate(db, MIGRATIONS.slice(0, reveals))
    db.exec("INSERT INTO seasons (label, phase, started_at) VALUES ('시즌 1', 'regular', 'now')")
    const add = db.prepare(
      `INSERT INTO suggestions (kind, status, target_kind, target_id, patch, reason, source, dedupe, times, season_id, round, file, auto, error, created_at, updated_at, decided_at)
       VALUES (?, ?, 'player', 'p1', ?, '이유', '{"postId":3}', ?, ?, 1, 2, ?, ?, ?, 'a', 'b', ?)`,
    )
    add.run('nickname', 'pending', '{"nicknames":["킹"]}', 'nickname:player:p1:킹', 2, null, 0, 'stale', null)
    add.run('fact', 'approved', '{"public":"이야기."}', 'fact:player:p1:public:1', 1, 'teams/가람고/가가가.md', 1, null, 'c')
    expect(() => add.run('reveal', 'pending', '{}', 'reveal:x', 1, null, 0, null, null)).toThrow(/CHECK/)
    const before = db.prepare('SELECT * FROM suggestions ORDER BY id').all()

    migrate(db)
    expect(db.prepare('SELECT * FROM suggestions ORDER BY id').all()).toEqual(before)
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'suggestions' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toEqual(['suggestions_by_dedupe', 'suggestions_by_job', 'suggestions_by_status', 'suggestions_waiting'])
    add.run('reveal', 'pending', '{"fromSecret":"비밀.","public":"비밀."}', 'reveal:player:p1:text:1:public', 1, null, 0, null, null)
    // Still one waiting card per key, and still only the kinds the app knows.
    expect(() => add.run('nickname', 'pending', '{}', 'nickname:player:p1:킹', 1, null, 0, null, null)).toThrow(/UNIQUE/)
    expect(() => add.run('bogus', 'pending', '{}', 'bogus', 1, null, 0, null, null)).toThrow(/CHECK/)
    db.close()
  })

  it('gives awards made before their team was kept his last box-line team that season, else his team now', () => {
    const db = new DatabaseSync(':memory:')
    const kept = MIGRATIONS.findIndex((m) => m.includes('ALTER TABLE awards ADD COLUMN team_id'))
    expect(kept).toBe(15)
    migrate(db, MIGRATIONS.slice(0, kept))
    seedLeague(db, sampleSetup())
    const season = currentSeason(db).id
    // p1 played round 2 for t2 and, in a game built later (a higher id), round 1 for t1; he's on t3 now.
    const game = db.prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, home_score, away_score, status) VALUES (?, 'regular', ?, ?, 't4', 100, 90, 'final')")
    const line = db.prepare("INSERT INTO box_lines (game_id, player_id, team_id, row_order, stats) VALUES (?, 'p1', ?, 0, '{}')")
    line.run(Number(game.run(season, 2, 't2').lastInsertRowid), 't2')
    line.run(Number(game.run(season, 1, 't1').lastInsertRowid), 't1')
    db.prepare("UPDATE players SET team_id = 't3' WHERE id = 'p1'").run()
    // p7 has no box line, and has moved from t2 to t5.
    db.prepare("UPDATE players SET team_id = 't5' WHERE id = 'p7'").run()
    const award = db.prepare("INSERT INTO awards (season_id, award_id, period, team_rank, player_id, created_at) VALUES (?, ?, '', 1, ?, 'now')")
    award.run(season, 'mvp', 'p1')
    award.run(season, 'dpoy', 'p7')

    migrate(db)
    expect(db.prepare('SELECT player_id, team_id FROM awards ORDER BY id').all()).toEqual([
      { player_id: 'p1', team_id: 't2' },
      { player_id: 'p7', team_id: 't5' },
    ])
    db.close()
  })

  it('rolls a failed transaction back', () => {
    const db = openDb(':memory:')
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO seasons (label, phase, started_at) VALUES ('x', 'preseason', 'now')")
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.prepare('SELECT COUNT(*) AS n FROM seasons').get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('seedLeague', () => {
  it('stores a setup and reads it back', () => {
    const file = tempFile()
    const setup = sampleSetup()
    const db = openDb(file)
    const season = seedLeague(db, setup)
    db.close()

    const again = openDb(file)
    expect(loadConfig(again)).toEqual({ config: setup.config, version: 1 })
    expect(listTeams(again)).toEqual(setup.teams)
    const players = listPlayers(again)
    expect(players.map(({ heightCm: _, ...p }) => p)).toEqual(setup.players)
    expect(players[0]!.heightCm).toBeCloseTo(185.4)
    expect(currentSeason(again)).toEqual(season)
    expect(listEvents(again)).toEqual([
      { id: 1, type: 'league_created', seasonId: season.id, payload: { teams: 8, players: 48 }, createdAt: expect.any(String) },
    ])
    again.close()
  })

  it('keeps number and grade ratings apart', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    expect(db.prepare("SELECT num, grade FROM ratings WHERE player_id = 'p1' ORDER BY column_id").all()).toEqual([
      { num: 70, grade: null },
      { num: null, grade: 'B+' },
    ])
    db.close()
  })

  it('refuses an invalid setup before writing anything', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.players[5]!.teamId = 'missing-team'
    expect(() => seedLeague(db, setup)).toThrow(SetupError)
    for (const table of ['league_config', 'teams', 'players', 'ratings', 'seasons', 'events']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
    db.close()
  })

  it('rejects ids with stray spaces instead of storing them', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.teams[0]!.divisionId = 'n '
    expect(() => seedLeague(db, setup)).toThrow(SetupError)
    db.close()
  })

  it('stores trimmed names', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.players[0]!.name = '  띄어쓴이름 '
    seedLeague(db, setup)
    expect(listPlayers(db)[0]!.name).toBe('띄어쓴이름')
    db.close()
  })

  it('refuses to seed twice', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    expect(() => seedLeague(db, sampleSetup())).toThrow(/not empty/)
    db.close()
  })

  it('versions config changes and records them', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    seedLeague(db, setup)
    setup.config.league.name = '바뀐 이름'
    expect(updateConfig(db, setup.config)).toBe(2)
    expect(loadConfig(db).config.league.name).toBe('바뀐 이름')
    expect(listEvents(db, 'config_changed').map((e) => e.payload)).toEqual([{ version: 2 }])
    db.close()
  })
})
