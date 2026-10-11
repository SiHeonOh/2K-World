import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { listEvents, listPlayers, listTeams, seedLeague } from '@data/league'
import { applyTrade, giveAward } from '@data/moves'
import { listGames, recordScore, startSeason } from '@data/season'
import { readLeague } from '@story/context'
import { lockerRoom, relationTarget, snapshotMoods } from '@story/mood'
import { planReactions } from '@story/triggers'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-mood-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** Plays `n` of a team's games where `starved` never shoots and a teammate takes everything. */
function play(teamId: string, starved: string, hog: string, n: number) {
  const games = listGames(db, 1).filter((g) => g.status === 'scheduled' && (g.home === teamId || g.away === teamId)).slice(0, n)
  for (const g of games) {
    const lines = [
      { playerId: hog, teamId, stats: { pts: 40, fgm: 16, fga: 30, fta: 10, ftm: 8, to: 3, reb: 5, ast: 2 } },
      { playerId: starved, teamId, stats: { pts: 0, fgm: 0, fga: 0, fta: 0, ftm: 0, to: 0, reb: 2, ast: 1 } },
    ]
    recordScore(db, { gameId: g.id, homeScore: g.home === teamId ? 60 : 90, awayScore: g.home === teamId ? 90 : 60, lines })
  }
}

describe('locker room', () => {
  it('a ball-hungry player starved of shots sours, and moods are snapshotted per game', () => {
    startSeason(db)
    const team = listTeams(db)[0]!
    const [a, b] = listPlayers(db).filter((p) => p.teamId === team.id)
    // a is hungry for the ball (from his lore file); b takes every shot.
    mkdirSync(join(dir, 'lore', 'teams', team.shortName), { recursive: true })
    writeFileSync(
      join(dir, 'lore', 'teams', team.shortName, `${a!.name}.md`),
      `---\nid: ${a!.name}\ntraits:\n  ego: 5\n  usage: 5\nhooks:\n  - when: losing_streak\n    mood: { winning: -20 }\n---\n`,
    )
    const league = () => readLeague(db, dir)
    const before = lockerRoom(league(), team.id).players.find((p) => p.playerId === a!.id)!
    expect(before.fromLore).toBe(true)
    expect(before.share).toBeNull()

    play(team.id, a!.id, b!.id, 4)
    const room = lockerRoom(league(), team.id)
    const after = room.players.find((p) => p.playerId === a!.id)!
    expect(after.share).toBe(0)
    expect(after.parts.usage).toBeLessThan(-40)
    expect(after.overall).toBeLessThan(before.overall)
    expect(room.games).toBe(4)
    // Worst mood first.
    expect(room.players.map((p) => p.overall)).toEqual([...room.players.map((p) => p.overall)].sort((x, y) => x - y))

    snapshotMoods(league(), team.id, Date.now())
    expect((db.prepare('SELECT COUNT(*) AS n FROM player_mood').get() as { n: number }).n).toBe(room.players.length)
  })

  it('reads 이름(학교) in relationships as the school he started at, like lore file names', () => {
    startSeason(db)
    const [t1, t2] = listTeams(db)
    const a = listPlayers(db).find((p) => p.teamId === t1!.id)!
    const b = listPlayers(db).find((p) => p.teamId === t2!.id && p.slotId === a.slotId)!
    db.prepare("UPDATE players SET name = '김하람' WHERE id IN (?, ?)").run(a.id, b.id)
    // The two 김하람 swap schools.
    applyTrade(db, [
      { kind: 'player', playerId: a.id, from: t1!.id, to: t2!.id },
      { kind: 'player', playerId: b.id, from: t2!.id, to: t1!.id },
    ])
    const league = readLeague(db, dir)
    expect(relationTarget(league, `김하람(${t1!.shortName})`)).toBe(a.id)
    expect(relationTarget(league, `김하람(${t2!.shortName})`)).toBe(b.id)
    expect(relationTarget(league, '김하람')).toBeNull()
  })

  it('fires a rival_award hook when the named rival wins an award', () => {
    startSeason(db)
    const [t1, t2] = listTeams(db)
    const a = listPlayers(db).find((p) => p.teamId === t1!.id)!
    const rival = listPlayers(db).find((p) => p.teamId === t2!.id)!
    mkdirSync(join(dir, 'lore', 'teams', t1!.shortName), { recursive: true })
    writeFileSync(
      join(dir, 'lore', 'teams', t1!.shortName, `${a.name}.md`),
      `---\nid: ${a.name}\nhooks:\n  - when: rival_award\n    rival: ${rival.name}\n    mood: { rivalry: -40 }\n---\n`,
    )
    const rivalryOf = () => lockerRoom(readLeague(db, dir), t1!.id).players.find((p) => p.playerId === a.id)!.parts.rivalry
    const before = rivalryOf()
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: rival.id })
    expect(rivalryOf()).toBe(Math.max(-100, before - 40))
  })

  it('records a band change as an event the community reacts to', () => {
    startSeason(db)
    const team = listTeams(db)[0]!
    const [a, b] = listPlayers(db).filter((p) => p.teamId === team.id)
    // A happy snapshot first, then a starved run.
    db.prepare("INSERT INTO player_mood (season_id, player_id, overall, band, parts, created_at) VALUES (1, ?, 60, 'happy', '{}', 'x')").run(a!.id)
    mkdirSync(join(dir, 'lore', 'teams', team.shortName), { recursive: true })
    writeFileSync(join(dir, 'lore', 'teams', team.shortName, `${a!.name}.md`), `---\nid: ${a!.name}\ntraits:\n  ego: 5\n  usage: 5\n  competitiveness: 5\n---\n`)
    play(team.id, a!.id, b!.id, 5)
    const changed = snapshotMoods(readLeague(db, dir), team.id, Date.now())
    expect(changed).toContain(a!.id)
    const events = listEvents(db, 'mood_changed')
    expect(events[0]!.payload).toMatchObject({ playerId: a!.id, from: 'happy' })
    expect(planReactions(events)).toEqual([{ kind: 'event_thread', events }])
  })
})
