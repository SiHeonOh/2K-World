import { migrateConfig } from '@shared/config/migrations'
import { leagueConfigSchema, phaseSchema, type LeagueConfig } from '@shared/config/schema'
import { parseHeightCm } from '@shared/height'
import type { EventPayloads, EventType, LeagueEvent } from '@shared/events'
import type { PlayerRow, SeasonInfo, SeasonListing } from '@shared/league'
import { ALWAYS_ASK } from '@shared/suggestions'
import { checkSetup, SetupError, type LeagueSetup, type Player, type RatingValue, type Team } from '@shared/setup'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { transaction, type Db } from './db'
import { MIGRATIONS } from './migrations'
import { refuse } from './rules'

const now = () => new Date().toISOString()

// ── Config ───────────────────────────────────────────────────────────────

/** Writes a new config version row. Old versions stay, so changes can be traced. */
function insertConfig(db: Db, config: LeagueConfig): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM league_config').get() as { v: number }
  const version = row.v + 1
  db.prepare('INSERT INTO league_config (version, json, created_at) VALUES (?, ?, ?)').run(
    version,
    JSON.stringify(leagueConfigSchema.parse(config)),
    now(),
  )
  return version
}

/** Saves a changed config as a new version, with a `config_changed` event (naming the 리그 설정 sections it changed, if given). */
export function updateConfig(db: Db, config: LeagueConfig, sections?: string[]): number {
  return transaction(db, () => {
    const version = insertConfig(db, config)
    appendEvent(db, 'config_changed', sections ? { version, sections } : { version }, currentSeason(db).id)
    return version
  })
}

/** The newest event that changes rosters or settings: a snapshot older than this is stale. */
export function factsStamp(db: Db): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE type IN ('trade_applied', 'move_vetoed', 'draft_swap', 'player_edited', 'slots_changed', 'config_changed', 'phase_changed', 'season_created', 'teams_edited')",
      )
      .get() as { n: number }
  ).n
}

export function loadConfig(db: Db): { config: LeagueConfig; version: number } {
  const row = db.prepare('SELECT version, json FROM league_config ORDER BY version DESC LIMIT 1').get() as
    | { version: number; json: string }
    | undefined
  if (!row) throw new Error('league has no config')
  const config = leagueConfigSchema.parse(migrateConfig(JSON.parse(row.json)))
  // Reveals always ask: 'auto' put in by hand reads as asking (편집실 then shows it, and saving isn't refused over it).
  for (const k of ALWAYS_ASK) if (config.lore.suggest[k] === 'auto') delete config.lore.suggest[k]
  return { config, version: row.version }
}

// ── Teams and players ────────────────────────────────────────────────────

export function insertTeams(db: Db, teams: Team[]): void {
  const stmt = db.prepare(
    'INSERT INTO teams (id, name, short_name, division_id, control, colors, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  teams.forEach((t, i) => stmt.run(t.id, t.name, t.shortName, t.divisionId, t.control, JSON.stringify(t.colors), i))
}

export function listTeams(db: Db): Team[] {
  const rows = db
    .prepare('SELECT id, name, short_name, division_id, control, colors FROM teams ORDER BY sort_order')
    .all() as { id: string; name: string; short_name: string; division_id: string; control: Team['control']; colors: string }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    divisionId: r.division_id,
    control: r.control,
    colors: JSON.parse(r.colors) as string[],
  }))
}

export function insertPlayers(db: Db, config: LeagueConfig, players: Player[]): void {
  const kinds = new Map(config.ratings.columns.map((c) => [c.id, c.kind]))
  const insertPlayer = db.prepare(
    `INSERT INTO players (id, team_id, name, slot_id, height, height_cm, nicknames, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertRating = db.prepare('INSERT INTO ratings (player_id, column_id, num, grade) VALUES (?, ?, ?, ?)')
  players.forEach((p, i) => {
    insertPlayer.run(
      p.id,
      p.teamId,
      p.name,
      p.slotId,
      p.height,
      parseHeightCm(p.height),
      JSON.stringify(p.nicknames),
      p.notes,
      i,
    )
    for (const [columnId, value] of Object.entries(p.ratings)) {
      if (value === null) continue
      if (kinds.get(columnId) === 'number') insertRating.run(p.id, columnId, value as number, null)
      else insertRating.run(p.id, columnId, null, String(value))
    }
  })
}

export function listPlayers(db: Db): PlayerRow[] {
  const rows = db
    .prepare(
      `SELECT id, team_id, name, slot_id, height, height_cm, nicknames, notes
       FROM players ORDER BY sort_order`,
    )
    .all() as {
    id: string
    team_id: string
    name: string
    slot_id: string | null
    height: string
    height_cm: number | null
    nicknames: string
    notes: string
  }[]
  const ratings = db.prepare('SELECT player_id, column_id, num, grade FROM ratings').all() as {
    player_id: string
    column_id: string
    num: number | null
    grade: string | null
  }[]
  const byPlayer = new Map<string, Record<string, RatingValue>>()
  for (const r of ratings) {
    const record = byPlayer.get(r.player_id) ?? {}
    record[r.column_id] = r.num ?? r.grade
    byPlayer.set(r.player_id, record)
  }
  return rows.map((r) => ({
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    slotId: r.slot_id,
    height: r.height,
    heightCm: r.height_cm,
    nicknames: JSON.parse(r.nicknames) as string[],
    notes: r.notes,
    ratings: byPlayer.get(r.id) ?? {},
  }))
}

// ── Seasons and events ───────────────────────────────────────────────────

export function createSeason(db: Db, label: string): SeasonInfo {
  const seed = randomBytes(8).toString('hex')
  const result = db
    .prepare("INSERT INTO seasons (label, phase, started_at, seed) VALUES (?, 'preseason', ?, ?)")
    .run(label, now(), seed)
  return { id: Number(result.lastInsertRowid), label, phase: 'preseason', seed }
}

export function currentSeason(db: Db): SeasonInfo {
  const row = db.prepare('SELECT id, label, phase, seed FROM seasons ORDER BY id DESC LIMIT 1').get() as
    | { id: number; label: string; phase: string; seed: string }
    | undefined
  if (!row) throw new Error('league has no season')
  return { id: row.id, label: row.label, phase: phaseSchema.parse(row.phase), seed: row.seed }
}

/**
 * The season a read asks for: the current one when no id is given, else
 * that season (refused when the league has none by that id). Only the
 * newest season is current; an older one is over.
 */
export function seasonFor(db: Db, seasonId?: number): SeasonInfo {
  if (seasonId === undefined) return currentSeason(db)
  const row = db.prepare('SELECT id, label, phase, seed FROM seasons WHERE id = ?').get(seasonId) as
    | { id: number; label: string; phase: string; seed: string }
    | undefined
  if (!row) refuse('unknown-season', { season: seasonId })
  return { id: row.id, label: row.label, phase: phaseSchema.parse(row.phase), seed: row.seed }
}

/** Every season, oldest first, for the screens' season pickers. */
export function listSeasons(db: Db): SeasonListing[] {
  const rows = db.prepare('SELECT id, label FROM seasons ORDER BY id').all() as { id: number; label: string }[]
  const newest = rows.at(-1)?.id
  return rows.map((r) => ({ id: r.id, label: r.label, current: r.id === newest }))
}

export function appendEvent<T extends EventType>(db: Db, type: T, payload: EventPayloads[T], seasonId: number | null): number {
  const result = db
    .prepare('INSERT INTO events (type, season_id, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(type, seasonId, JSON.stringify(payload), now())
  return Number(result.lastInsertRowid)
}

/** Events after `id`, oldest first. */
export function listEventsAfter(db: Db, id: number): LeagueEvent[] {
  const rows = db.prepare('SELECT id, type, season_id, payload, created_at FROM events WHERE id > ? ORDER BY id').all(id) as {
    id: number
    type: EventType
    season_id: number | null
    payload: string
    created_at: string
  }[]
  return rows.map((r) => ({ id: r.id, type: r.type, seasonId: r.season_id, payload: JSON.parse(r.payload) as EventPayloads[EventType], createdAt: r.created_at }))
}

export function listEvents(db: Db, type?: EventType): LeagueEvent[] {
  const sql = 'SELECT id, type, season_id, payload, created_at FROM events'
  const rows = (
    type === undefined
      ? db.prepare(`${sql} ORDER BY id`).all()
      : db.prepare(`${sql} WHERE type = ? ORDER BY id`).all(type)
  ) as { id: number; type: EventType; season_id: number | null; payload: string; created_at: string }[]
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    seasonId: r.season_id,
    payload: JSON.parse(r.payload) as EventPayloads[EventType],
    createdAt: r.created_at,
  }))
}

// ── Creating a league ────────────────────────────────────────────────────

/**
 * Validates a setup and writes it into an empty league database, in one
 * transaction: config v1, teams, players and ratings, the first season, and
 * a `league_created` event. Throws SetupError if the setup has errors; only
 * the parsed (trimmed) copy is stored.
 */
export function seedLeague(db: Db, input: LeagueSetup): SeasonInfo {
  const checked = checkSetup(input)
  if (!checked.ok) throw new SetupError(checked.issues)
  const setup = checked.setup
  const existing = db.prepare('SELECT COUNT(*) AS n FROM league_config').get() as { n: number }
  if (existing.n > 0) throw new Error('league database is not empty')
  return transaction(db, () => {
    insertConfig(db, setup.config)
    insertTeams(db, setup.teams)
    insertPlayers(db, setup.config, setup.players)
    const season = createSeason(db, setup.config.season.label)
    appendEvent(db, 'league_created', { teams: setup.teams.length, players: setup.players.length }, season.id)
    return season
  })
}

// ── Peeking without holding the file ─────────────────────────────────────

export interface LeaguePeek {
  name: string
  teams: number
  players: number
  season: string | null
}

/**
 * Reads a league's headline facts through a short-lived read-only handle.
 * Listing leagues must not keep files open: on Windows an open WAL handle
 * stops the folder from being renamed, synced or deleted.
 */
export function peekLeague(file: string): LeaguePeek {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > MIGRATIONS.length) throw new Error(`database schema v${version} is newer than this app`)
    if (version === 0) throw new Error('not a league database')
    const config = db.prepare('SELECT json FROM league_config ORDER BY version DESC LIMIT 1').get() as { json: string } | undefined
    const name = config ? String((JSON.parse(config.json) as { league?: { name?: unknown } }).league?.name ?? '') : ''
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const season = db.prepare('SELECT label FROM seasons ORDER BY id DESC LIMIT 1').get() as { label: string } | undefined
    return { name, teams: count('teams'), players: count('players'), season: season?.label ?? null }
  } finally {
    db.close()
  }
}
