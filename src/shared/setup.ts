import { z } from 'zod'
import { idSchema, leagueConfigSchema, teamControlSchema, type LeagueConfig } from './config/schema'
import { ALWAYS_ASK } from './suggestions'

/**
 * A league's starting data: config plus teams and players. The setup wizard
 * builds one, templates carry one, and the League engine creates a league
 * from one.
 */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const teamSchema = z.object({
  id: idSchema,
  /** Full name, as in the source sheet. */
  name: z.string().trim().min(1).max(80),
  /** Display name; also the team's lore folder name. */
  shortName: z.string().trim().min(1).max(40),
  divisionId: idSchema,
  control: teamControlSchema,
  colors: z.array(hexColor).max(4),
})

export const ratingValueSchema = z.union([z.number(), z.string()]).nullable()

export const playerSchema = z.object({
  id: idSchema,
  teamId: idSchema,
  name: z.string().trim().min(1).max(80),
  slotId: idSchema.nullable(),
  /** As written in the source, e.g. 6'4" or 193cm. */
  height: z.string().trim().max(20),
  nicknames: z.array(z.string().trim().min(1).max(60)).max(20),
  notes: z.string().max(4000),
  ratings: z.record(z.string(), ratingValueSchema),
})

export const leagueSetupSchema = z.object({
  config: leagueConfigSchema,
  teams: z.array(teamSchema),
  players: z.array(playerSchema),
})

export type Team = z.infer<typeof teamSchema>
export type Player = z.infer<typeof playerSchema>
export type RatingValue = z.infer<typeof ratingValueSchema>
export type LeagueSetup = z.infer<typeof leagueSetupSchema>

// ── Cross-checks ─────────────────────────────────────────────────────────

/**
 * Codes are translated in the renderer (`i18n/ko.ts`), so this file stays
 * language-free. `section` tells the wizard which step to send you to.
 */
export type IssueCode =
  | 'schema'
  | 'duplicate-id'
  | 'duplicate-name'
  | 'unknown-conference'
  | 'unknown-division'
  | 'unknown-team'
  | 'unknown-slot'
  | 'unknown-rating-column'
  | 'unknown-overall'
  | 'rating-out-of-range'
  | 'rating-not-number'
  | 'rating-unknown-grade'
  | 'rating-missing'
  | 'roster-size'
  | 'roster-slot-missing'
  | 'roster-slot-duplicate'
  | 'roster-slot-required'
  | 'roster-min-max'
  | 'rating-min-max'
  | 'no-teams'
  | 'division-without-conference'
  | 'finals-needs-two-conferences'
  | 'playoff-field-not-power-of-two'
  | 'playoff-field-too-big'
  | 'card-tier-order'
  | 'card-tier-gap'
  | 'card-tier-overlap'
  | 'card-tier-short'
  | 'incoming-slot-conflict'
  | 'all-frozen'
  | 'team-name-not-folder-safe'
  | 'roster-slot-count'
  | 'grade-scale-order'
  | 'duplicate-tiebreaker'
  | 'finals-needs-conference-bracket'
  | 'no-conferences'
  | 'playoff-field-too-small'
  | 'reveal-always-asks'
  | 'draft-standard-none'
  | 'played-needs-round-robin'

export type SetupSection =
  | 'league'
  | 'structure'
  | 'teams'
  | 'roster'
  | 'ratings'
  | 'season'
  | 'awards'
  | 'trades'
  | 'draft'
  | 'gm'
  | 'players'

export interface SetupIssue {
  level: 'error' | 'warning'
  code: IssueCode
  section: SetupSection
  /** Values the message needs: names, counts, the bad value. */
  params: Record<string, string | number>
  /** JSON path into the setup, for highlighting. */
  path: (string | number)[]
}

const sectionOfConfigPath = (path: PropertyKey[]): SetupSection => {
  if (path[0] === 'teams') return 'teams'
  if (path[0] === 'players') return 'players'
  const key = path[0] === 'config' ? path[1] : path[0]
  switch (key) {
    case 'structure':
      return 'structure'
    case 'roster':
      return 'roster'
    case 'ratings':
    case 'playerFields':
      return 'ratings'
    case 'season':
      return 'season'
    case 'awards':
      return 'awards'
    case 'trades':
      return 'trades'
    case 'draft':
      return 'draft'
    case 'gm':
      return 'gm'
    default:
      return 'league'
  }
}

export type SetupCheck =
  | { ok: true; setup: LeagueSetup; issues: SetupIssue[] }
  | { ok: false; issues: SetupIssue[] }

/**
 * Parses and cross-checks a setup. On success `setup` is the parsed copy
 * (names trimmed): store that one, not the input. Warnings may remain.
 */
export function checkSetup(input: unknown): SetupCheck {
  const parsed = leagueSetupSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        level: 'error' as const,
        code: 'schema' as const,
        section: sectionOfConfigPath(i.path),
        params: { message: i.message },
        path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
      })),
    }
  }
  const issues = crossCheck(parsed.data)
  // How games are built belongs to a round robin: a custom game count can't be played as 2K 일정대로
  // (the schema would quietly drop the setting, and the league would draw its games at season start).
  const rawSchedule = (input as { config?: { season?: { schedule?: { kind?: unknown; build?: unknown } } } } | null)?.config?.season?.schedule
  if (rawSchedule && rawSchedule.kind !== 'round-robin' && rawSchedule.build === 'played') {
    issues.push({ level: 'error', code: 'played-needs-round-robin', section: 'season', params: {}, path: ['config', 'season', 'schedule', 'build'] })
  }
  // 'standard' (a reverse-order draft) never ran: after the playoffs the season goes straight to the
  // offseason. An old template or config with it is read as no draft, and the stored copy says so.
  if (parsed.data.config.draft.kind === 'standard') {
    issues.push({ level: 'warning', code: 'draft-standard-none', section: 'draft', params: {}, path: ['config', 'draft', 'kind'] })
    parsed.data.config.draft = { kind: 'none' }
  }
  return hasErrors(issues) ? { ok: false, issues } : { ok: true, setup: parsed.data, issues }
}

/** Shape errors (from Zod) plus every cross-check, as one list. */
export function validateSetup(input: unknown): SetupIssue[] {
  return checkSetup(input).issues
}

export function hasErrors(issues: SetupIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}

export class SetupError extends Error {
  constructor(readonly issues: SetupIssue[]) {
    super(`invalid league setup: ${issues.filter((i) => i.level === 'error').map((i) => i.code).join(', ')}`)
  }
}

/** Windows-safe folder names: team short names double as lore folder names. */
const FOLDER_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const FOLDER_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])(\..*)?$/i
export function isFolderSafe(name: string): boolean {
  return !FOLDER_BAD_CHARS.test(name) && !/[. ]$/.test(name) && !FOLDER_RESERVED.test(name) && name !== '..'
}

/** How the file system compares names: case-folded, NFC. */
export const folderKey = (name: string) => name.normalize('NFC').toLowerCase()

function crossCheck(setup: LeagueSetup): SetupIssue[] {
  const issues: SetupIssue[] = []
  const { config, teams, players } = setup
  const err = (section: SetupSection, code: IssueCode, path: SetupIssue['path'], params: SetupIssue['params'] = {}) =>
    issues.push({ level: 'error', code, section, params, path })
  const warn = (section: SetupSection, code: IssueCode, path: SetupIssue['path'], params: SetupIssue['params'] = {}) =>
    issues.push({ level: 'warning', code, section, params, path })

  const uniqueIds = <T extends { id: string }>(items: T[], section: SetupSection, path: SetupIssue['path']) => {
    const seen = new Set<string>()
    items.forEach((item, i) => {
      if (seen.has(item.id)) err(section, 'duplicate-id', [...path, i, 'id'], { id: item.id })
      seen.add(item.id)
    })
  }

  // Structure
  const { conferences, divisions } = config.structure
  uniqueIds(conferences, 'structure', ['config', 'structure', 'conferences'])
  uniqueIds(divisions, 'structure', ['config', 'structure', 'divisions'])
  const conferenceIds = new Set(conferences.map((c) => c.id))
  divisions.forEach((d, i) => {
    if (d.conferenceId !== null && !conferenceIds.has(d.conferenceId)) {
      err('structure', 'unknown-conference', ['config', 'structure', 'divisions', i, 'conferenceId'], {
        division: d.name,
        id: d.conferenceId,
      })
    }
  })

  // Teams
  if (teams.length === 0) err('teams', 'no-teams', ['teams'])
  uniqueIds(teams, 'teams', ['teams'])
  const divisionIds = new Set(divisions.map((d) => d.id))
  const shortNames = new Map<string, number>()
  teams.forEach((t, i) => {
    if (!divisionIds.has(t.divisionId)) {
      err('teams', 'unknown-division', ['teams', i, 'divisionId'], { team: t.shortName, id: t.divisionId })
    }
    const key = folderKey(t.shortName)
    if (shortNames.has(key)) err('teams', 'duplicate-name', ['teams', i, 'shortName'], { name: t.shortName })
    shortNames.set(key, i)
    if (!isFolderSafe(t.shortName)) err('teams', 'team-name-not-folder-safe', ['teams', i, 'shortName'], { name: t.shortName })
  })
  if (teams.length > 0 && teams.every((t) => t.control === 'frozen')) {
    warn('gm', 'all-frozen', ['teams'])
  }

  // Lore suggestions: a secret is never revealed by a setting.
  for (const k of ALWAYS_ASK) {
    if (config.lore.suggest[k] === 'auto') err('league', 'reveal-always-asks', ['config', 'lore', 'suggest', k], { kind: k })
  }

  // Roster
  const { roster } = config
  uniqueIds(roster.slots, 'roster', ['config', 'roster', 'slots'])
  if (roster.minPlayers > roster.maxPlayers) {
    err('roster', 'roster-min-max', ['config', 'roster', 'minPlayers'], {
      min: roster.minPlayers,
      max: roster.maxPlayers,
    })
  }
  if (
    roster.slotMode === 'one-per-slot' &&
    (roster.minPlayers !== roster.slots.length || roster.maxPlayers !== roster.slots.length)
  ) {
    err('roster', 'roster-slot-count', ['config', 'roster'], { slots: roster.slots.length })
  }
  const slotIds = new Set(roster.slots.map((s) => s.id))

  // Ratings
  const { ratings } = config
  uniqueIds(ratings.columns, 'ratings', ['config', 'ratings', 'columns'])
  const columns = new Map(ratings.columns.map((c) => [c.id, c]))
  const grades = new Set(ratings.gradeScale.map((g) => g.label))
  ratings.columns.forEach((c, i) => {
    if (c.kind === 'number' && c.min > c.max) {
      err('ratings', 'rating-min-max', ['config', 'ratings', 'columns', i], { column: c.name })
    }
  })
  const labels = new Set<string>()
  ratings.gradeScale.forEach((g, i) => {
    const path = ['config', 'ratings', 'gradeScale', i]
    if (labels.has(g.label)) err('ratings', 'duplicate-id', path, { id: g.label })
    labels.add(g.label)
    const prev = ratings.gradeScale[i - 1]
    if (prev && g.value >= prev.value) err('ratings', 'grade-scale-order', path, { grade: g.label })
  })
  uniqueIds([...config.awards.season, ...config.awards.periodic], 'awards', ['config', 'awards'])
  const tiebreakers = config.season.standings.tiebreakers
  if (new Set(tiebreakers).size !== tiebreakers.length) {
    err('season', 'duplicate-tiebreaker', ['config', 'season', 'standings', 'tiebreakers'])
  }
  if (ratings.overallColumnId !== null) {
    const overall = columns.get(ratings.overallColumnId)
    if (!overall) {
      err('ratings', 'unknown-overall', ['config', 'ratings', 'overallColumnId'], { id: ratings.overallColumnId })
    }
  }

  // Players
  uniqueIds(players, 'players', ['players'])
  const teamIds = new Set(teams.map((t) => t.id))
  const byTeam = new Map<string, number[]>()
  players.forEach((p, i) => {
    if (!teamIds.has(p.teamId)) {
      err('players', 'unknown-team', ['players', i, 'teamId'], { player: p.name, id: p.teamId })
    } else {
      const list = byTeam.get(p.teamId) ?? []
      list.push(i)
      byTeam.set(p.teamId, list)
    }
    if (p.slotId !== null && !slotIds.has(p.slotId)) {
      err('players', 'unknown-slot', ['players', i, 'slotId'], { player: p.name, id: p.slotId })
    }
    if (p.slotId === null && roster.slotMode === 'one-per-slot') {
      err('players', 'roster-slot-required', ['players', i, 'slotId'], { player: p.name })
    }
    for (const [colId, value] of Object.entries(p.ratings)) {
      const col = columns.get(colId)
      const path = ['players', i, 'ratings', colId]
      if (!col) {
        err('players', 'unknown-rating-column', path, { player: p.name, id: colId })
        continue
      }
      if (value === null) continue
      if (col.kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          err('players', 'rating-not-number', path, { player: p.name, column: col.name, value: String(value) })
        } else if (value < col.min || value > col.max) {
          err('players', 'rating-out-of-range', path, {
            player: p.name,
            column: col.name,
            value,
            min: col.min,
            max: col.max,
          })
        }
      } else if (typeof value !== 'string' || !grades.has(value)) {
        err('players', 'rating-unknown-grade', path, { player: p.name, column: col.name, value: String(value) })
      }
    }
    const missing = ratings.columns.filter((c) => p.ratings[c.id] === undefined || p.ratings[c.id] === null)
    if (missing.length > 0) {
      warn('players', 'rating-missing', ['players', i, 'ratings'], {
        player: p.name,
        columns: missing.map((c) => c.name).join(', '),
      })
    }
  })

  // Roster rules per team
  for (const team of teams) {
    const idx = byTeam.get(team.id) ?? []
    const name = team.shortName
    if (roster.slotMode === 'one-per-slot') {
      if (idx.length !== roster.slots.length) {
        err('roster', 'roster-size', ['teams', teams.indexOf(team)], {
          team: name,
          count: idx.length,
          expected: roster.slots.length,
        })
      }
      const filled = new Map<string, number>()
      for (const i of idx) {
        const slot = players[i]!.slotId
        if (slot === null) continue
        filled.set(slot, (filled.get(slot) ?? 0) + 1)
      }
      for (const s of roster.slots) {
        const n = filled.get(s.id) ?? 0
        if (n === 0) err('roster', 'roster-slot-missing', ['teams', teams.indexOf(team)], { team: name, slot: s.name })
        if (n > 1) {
          err('roster', 'roster-slot-duplicate', ['teams', teams.indexOf(team)], { team: name, slot: s.name, count: n })
        }
      }
    } else if (idx.length < roster.minPlayers || idx.length > roster.maxPlayers) {
      err('roster', 'roster-size', ['teams', teams.indexOf(team)], {
        team: name,
        count: idx.length,
        expected: `${roster.minPlayers}–${roster.maxPlayers}`,
      })
    }
  }

  // Playoffs
  checkPlayoffs(config, teams, err)

  // Draft
  const { draft } = config
  if (draft.kind === 'card-swap') {
    // Ranks are the overall 1–N ranking of every team, frozen ones included
    // (they get a rank but sit out the draft). Tiers may be listed in any order.
    const tiers = draft.allocation.map((tier, index) => ({ ...tier, index })).sort((a, b) => a.fromRank - b.fromRank)
    let expectFrom = 1
    for (const tier of tiers) {
      const path = ['config', 'draft', 'allocation', tier.index]
      if (tier.fromRank > tier.toRank) {
        err('draft', 'card-tier-order', path, { from: tier.fromRank, to: tier.toRank })
        continue
      }
      if (tier.fromRank > expectFrom) err('draft', 'card-tier-gap', path, { from: expectFrom, to: tier.fromRank - 1 })
      if (tier.fromRank < expectFrom) err('draft', 'card-tier-overlap', path, { rank: tier.fromRank })
      expectFrom = Math.max(expectFrom, tier.toRank + 1)
    }
    const lastCovered = expectFrom - 1
    if (lastCovered < teams.length) {
      warn('draft', 'card-tier-short', ['config', 'draft', 'allocation'], { covered: lastCovered, teams: teams.length })
    }
    if (draft.incomingSlot === 'own' && draft.slotRule === 'any' && roster.slotMode === 'one-per-slot') {
      err('draft', 'incoming-slot-conflict', ['config', 'draft', 'incomingSlot'])
    }
  }

  return issues
}

function checkPlayoffs(
  config: LeagueConfig,
  teams: Team[],
  err: (section: SetupSection, code: IssueCode, path: SetupIssue['path'], params?: SetupIssue['params']) => void,
) {
  const { playoffs } = config.season
  if (!playoffs.enabled) return
  const { conferences, divisions } = config.structure
  const field = playoffs.directSeeds + (playoffs.playIn.enabled ? 2 : 0)
  const path = ['config', 'season', 'playoffs']

  if (field < 2) err('season', 'playoff-field-too-small', path, { field })
  if (playoffs.bracket === 'league' && playoffs.finals.kind === 'conference-champions') {
    err('season', 'finals-needs-conference-bracket', [...path, 'finals'])
  }
  if (playoffs.bracket === 'conference') {
    if (conferences.length === 0) err('structure', 'no-conferences', ['config', 'structure', 'conferences'])
    divisions.forEach((d, i) => {
      if (d.conferenceId === null) {
        err('structure', 'division-without-conference', ['config', 'structure', 'divisions', i], { division: d.name })
      }
    })
    if (playoffs.finals.kind === 'conference-champions' && conferences.length !== 2) {
      err('season', 'finals-needs-two-conferences', [...path, 'finals'], { count: conferences.length })
    }
    for (const conf of conferences) {
      const divs = new Set(divisions.filter((d) => d.conferenceId === conf.id).map((d) => d.id))
      const size = teams.filter((t) => divs.has(t.divisionId)).length
      const needed = playoffs.directSeeds + (playoffs.playIn.enabled ? 4 : 0)
      if (size < needed) {
        err('season', 'playoff-field-too-big', path, { group: conf.name, teams: size, needed })
      }
    }
  } else {
    const needed = playoffs.directSeeds + (playoffs.playIn.enabled ? 4 : 0)
    if (teams.length < needed) err('season', 'playoff-field-too-big', path, { group: '', teams: teams.length, needed })
  }
  if (field & (field - 1)) err('season', 'playoff-field-not-power-of-two', path, { field })
}
