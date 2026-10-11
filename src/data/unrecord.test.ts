import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { migrate, openDb, type Db } from './db'
import { cancelQueuedForGame, listJobsByInput } from './jobs'
import { currentSeason, listEvents, seedLeague } from './league'
import { MIGRATIONS } from './migrations'
import { RuleError } from './rules'
import { addScheduledGame, removeScheduledGame } from './schedule'
import { boxLines, getGame, listGames, playoffsView, recordScore, standings, startPlayoffs, startSeason, unrecordGame } from './season'

function league(): Db {
  const db = openDb(':memory:')
  seedLeague(db, sampleSetup())
  return db
}

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}

/** Lower team number wins by 10. */
function playRegular(db: Db) {
  for (const g of listGames(db, currentSeason(db).id).filter((x) => x.stage === 'regular' && x.status === 'scheduled')) {
    const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
    recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
  }
}

/** The east first-round series, and a way to play its next game (the high seed winning or not). */
function eastSeries(db: Db) {
  const series = () => playoffsView(db).series.find((x) => x.slot === 'east:r1:0')!
  const high = series().high!
  const next = () => listGames(db, currentSeason(db).id).find((x) => x.seriesId === series().id && x.status === 'scheduled')
  const play = (highWins: boolean, g = next()!) => {
    recordScore(db, { gameId: g.id, homeScore: highWins === (g.home === high) ? 100 : 90, awayScore: highWins === (g.home === high) ? 90 : 100, lines: null })
    return g
  }
  return { series, high, next, play }
}

/** A live thread you started on a game, and a screenshot reading waiting for it. */
function attach(db: Db, gameId: number) {
  if (!db.prepare("SELECT 1 FROM personas WHERE id = 'me'").get()) {
    db.prepare("INSERT INTO personas (id, kind, nick, archetype, spice, level) VALUES ('me', 'user', '나', 'user', 1, 1)").run()
  }
  const post = Number(
    db
      .prepare("INSERT INTO posts (board_id, author_id, kind, title, body, game_id, shown_at, last_activity) VALUES ('main', 'me', 'live', '라이브', '', ?, 'now', 'now')")
      .run(gameId).lastInsertRowid,
  )
  const job = Number(
    db
      .prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('read_box_score', 'queued', 50, ?, 'now')")
      .run(JSON.stringify({ images: ['1.png'], teams: ['가', '나'], gameId })).lastInsertRowid,
  )
  return { post, job }
}

describe('correcting a playoff game that ends its series', () => {
  it('lets go of a live thread and a reading on the next game instead of failing on a foreign key', () => {
    const db = league()
    startSeason(db)
    playRegular(db)
    startPlayoffs(db)
    const east = eastSeries(db)
    east.play(true)
    east.play(true)
    east.play(true)
    const game4 = east.play(false)
    // 3-1: game 5 is scheduled, with a live thread and a reading on it.
    const game5 = east.next()!
    const { post, job } = attach(db, game5.id)
    // Game 4 was a high-seed win after all: 4-0, and game 5 goes.
    recordScore(db, { gameId: game4.id, homeScore: game4.home === east.high ? 100 : 90, awayScore: game4.home === east.high ? 90 : 100, lines: null })
    expect(east.series().winner).toBe(east.high)
    expect(getGame(db, game5.id)).toBeNull()
    expect(db.prepare('SELECT kind, game_id FROM posts WHERE id = ?').get(post)).toEqual({ kind: 'live', game_id: null })
    const reading = db.prepare('SELECT status, input FROM jobs WHERE id = ?').get(job) as { status: string; input: string }
    expect(reading.status).toBe('cancelled')
    expect(JSON.parse(reading.input)).not.toHaveProperty('gameId')
  })
})

describe('game ids', () => {
  it('are never handed out twice, even after the newest game is removed', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'manual' }
    seedLeague(db, setup)
    startSeason(db)
    const { gameId } = addScheduledGame(db, { round: 1, home: 't1', away: 't2' })
    removeScheduledGame(db, gameId)
    expect(addScheduledGame(db, { round: 1, home: 't1', away: 't2' }).gameId).toBeGreaterThan(gameId)
  })

  it('start past every id anything named when an older league is upgraded', () => {
    // A league made before migration 19.
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 18))
    seedLeague(old, sampleSetup())
    startSeason(old)
    const season = currentSeason(old).id
    const insert = old.prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, status) VALUES (?, 'regular', 1, 't1', 't2', 'scheduled')")
    const kept = Number(insert.run(season).lastInsertRowid)
    // A played game with a box line and a thread: the rebuild must not cascade them away.
    const played = Number(insert.run(season).lastInsertRowid)
    old.exec('PRAGMA foreign_keys = ON')
    recordScore(old, { gameId: played, homeScore: 80, awayScore: 70, lines: [{ playerId: 'p1', teamId: 't1', stats: { pts: 20 } }] })
    attach(old, played)
    // A game 40 was read for, then deleted: its reading still names it.
    old.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('read_box_score', 'cancelled', 50, ?, 'now')").run(JSON.stringify({ gameId: 40 }))
    migrate(old)
    const next = Number(insert.run(season).lastInsertRowid)
    expect(next).toBe(41)
    expect(kept).toBeLessThan(40)
    // Nothing was lost on the way.
    expect(getGame(old, kept)).toMatchObject({ home: 't1', away: 't2', status: 'scheduled' })
    expect(getGame(old, played)).toMatchObject({ status: 'final', homeScore: 80, hasBox: true })
    expect(boxLines(old, played)).toHaveLength(1)
    expect(old.prepare('SELECT COUNT(*) AS n FROM posts WHERE game_id = ?').get(played)).toEqual({ n: 1 })
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('count on from whole ids only, so stray stored values can’t use the counter up', () => {
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 18))
    seedLeague(old, sampleSetup())
    startSeason(old)
    const job = old.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('read_box_score', 'cancelled', 50, ?, 'now')")
    for (const input of ['{"gameId":1e300}', '{"gameId":4611686018427387904}', '{"gameId":"abc"}', '{"gameId":-5}', 'not json {', '{"gameId":40}']) job.run(input)
    old.prepare("INSERT INTO events (type, season_id, payload, created_at) VALUES ('news_posted', NULL, ?, 'now')").run('{"gameId":9e18}')
    old.prepare("INSERT INTO events (type, season_id, payload, created_at) VALUES ('news_posted', NULL, ?, 'now')").run('nope')
    migrate(old)
    expect(old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'games'").get()).toEqual({ seq: 40 })
    const next = old.prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, status) VALUES (?, 'regular', 1, 't1', 't2', 'scheduled')").run(currentSeason(old).id)
    expect(Number(next.lastInsertRowid)).toBe(41)
  })
})

describe('a stored job or event that isn’t JSON', () => {
  it('doesn’t stop the game functions that look through jobs', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'manual' }
    seedLeague(db, setup)
    startSeason(db)
    const bad = (kind: string) =>
      db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES (?, 'failed', 50, 'not json {', 'now')").run(kind)
    bad('read_box_score')
    bad('post_game_thread')
    db.prepare("INSERT INTO events (type, season_id, payload, created_at) VALUES ('draft_swap', NULL, 'nope', 'now')").run()
    const { gameId } = addScheduledGame(db, { round: 1, home: 't1', away: 't2' })
    const reading = Number(
      db
        .prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('read_box_score', 'done', 50, ?, 'now')")
        .run(JSON.stringify({ gameId, hashes: ['a'] })).lastInsertRowid,
    )
    expect(listJobsByInput(db, 'read_box_score', 'gameId', gameId).map((j) => j.id)).toEqual([reading])
    expect(cancelQueuedForGame(db, 'post_game_thread', gameId, 'test')).toBe(0)
    // Taking the game out (dropGame) lets go of its reading.
    removeScheduledGame(db, gameId)
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(reading)).toEqual({ status: 'cancelled' })
  })
})

describe('기록 취소 (unrecording a game)', () => {
  it('puts a regular-season game back to unplayed, standings and box lines too', () => {
    const db = league()
    startSeason(db)
    const g = listGames(db, currentSeason(db).id).find((x) => x.home === 't1' || x.away === 't1')!
    recordScore(db, {
      gameId: g.id,
      homeScore: 101,
      awayScore: 99,
      lines: [{ playerId: 'p1', teamId: 't1', stats: { pts: 30 } }],
    })
    expect(standings(db).played).toBe(1)
    unrecordGame(db, g.id)
    expect(getGame(db, g.id)).toMatchObject({ status: 'scheduled', homeScore: null, awayScore: null, hasBox: false })
    expect(boxLines(db, g.id)).toEqual([])
    expect(standings(db).played).toBe(0)
    expect(listEvents(db, 'game_unrecorded').map((e) => e.payload)).toEqual([
      { gameId: g.id, stage: 'regular', home: g.home, away: g.away, homeScore: 101, awayScore: 99 },
    ])
    // Only a played game, and it can be recorded again.
    expect(refusal(() => unrecordGame(db, g.id))).toEqual(['unrecord-not-played'])
    recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 99, lines: null })
    expect(getGame(db, g.id)).toMatchObject({ status: 'final', awayScore: 99 })
  })

  it('leaves regular-season games alone once the playoffs start', () => {
    const db = league()
    startSeason(db)
    playRegular(db)
    startPlayoffs(db)
    const regular = listGames(db, currentSeason(db).id).find((x) => x.stage === 'regular')!
    expect(refusal(() => unrecordGame(db, regular.id))).toEqual(['unrecord-regular-closed'])
  })

  it('takes back the last game of a playoff series, reopening a series it decided', () => {
    const db = league()
    startSeason(db)
    playRegular(db)
    startPlayoffs(db)
    const east = eastSeries(db)
    const game1 = east.play(true)
    east.play(true)
    // Not the last one played.
    expect(refusal(() => unrecordGame(db, game1.id))).toEqual(['unrecord-not-last'])
    east.play(true)
    const game4 = east.play(true)
    expect(east.series().winner).toBe(east.high)
    unrecordGame(db, game4.id)
    // 3-0 again, game 4 next (the same game, not a new one), and the result taken back.
    expect(east.series()).toMatchObject({ winner: null, highWins: 3, lowWins: 0 })
    expect(east.next()!.id).toBe(game4.id)
    expect(listGames(db, currentSeason(db).id).filter((x) => x.seriesId === east.series().id && x.status === 'scheduled')).toHaveLength(1)
    expect(listEvents(db, 'series_result_changed').map((e) => e.payload)).toEqual([
      { seriesId: east.series().id, slot: 'east:r1:0', before: east.high, after: null },
    ])
  })

  it('drops the series game scheduled after it, letting go of what pointed at it', () => {
    const db = league()
    startSeason(db)
    playRegular(db)
    startPlayoffs(db)
    const east = eastSeries(db)
    east.play(true)
    const game2 = east.play(false)
    const game3 = east.next()!
    const { post } = attach(db, game3.id)
    unrecordGame(db, game2.id)
    expect(getGame(db, game3.id)).toBeNull()
    expect(east.next()!.id).toBe(game2.id)
    expect((db.prepare('SELECT game_id FROM posts WHERE id = ?').get(post) as { game_id: number | null }).game_id).toBeNull()
  })

  it('refuses once a series it fed has played', () => {
    const db = league()
    startSeason(db)
    playRegular(db)
    startPlayoffs(db)
    // Both first-round series go 4-0 to the high seed; the final's first game is played.
    for (let i = 0; i < 40; i++) {
      const open = listGames(db, currentSeason(db).id).filter((x) => x.stage !== 'regular' && x.status === 'scheduled')
      const final = open.find((x) => playoffsView(db).series.find((s) => s.id === x.seriesId)!.slot === 'finals')
      if (final) {
        recordScore(db, { gameId: final.id, homeScore: 100, awayScore: 90, lines: null })
        break
      }
      for (const g of open) {
        const s = playoffsView(db).series.find((x) => x.id === g.seriesId)!
        recordScore(db, { gameId: g.id, homeScore: g.home === s.high ? 100 : 90, awayScore: g.home === s.high ? 90 : 100, lines: null })
      }
    }
    const east = eastSeries(db)
    const last = listGames(db, currentSeason(db).id)
      .filter((x) => x.seriesId === east.series().id)
      .sort((a, b) => b.round - a.round)[0]!
    expect(refusal(() => unrecordGame(db, last.id))).toEqual(['series-already-continued'])
  })
})
