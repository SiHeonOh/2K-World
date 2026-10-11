import type { LeagueConfig, Phase } from '@shared/config/schema'
import type { SeasonInfo } from '@shared/league'
import { playedMode } from '@shared/played'
import type { RuleIssue } from '@shared/season'
import { folderKey, hasErrors, leagueSetupSchema, SetupError, validateSetup, type SetupIssue, type Team } from '@shared/setup'
import {
  applySettings,
  changedSections,
  effectiveDraft,
  settingsOf,
  type LeagueSettingsInput,
  type SectionLock,
  type SettingsSaveResult,
  type SettingsSection,
  type SettingsState,
} from '@shared/settings'
import { transaction, type Db } from './db'
import { appendEvent, currentSeason, listPlayers, listTeams, loadConfig, updateConfig } from './league'
import { closeSwitchedRounds, unplayedRegularGames } from './played'
import { RuleError } from './rules'
import { guaranteedCards } from './season'

/**
 * Changing a league's settings after it exists. Each section has its time
 * (see `sectionLocks`), every change is checked with the same setup check
 * the wizard uses (against today's players), and a save is one transaction:
 * a new config version (when the config changed) plus the teams.
 */

const OPEN: SectionLock = { open: true, code: null, params: {} }
const locked = (code: string, params: SectionLock['params'] = {}): SectionLock => ({ open: false, code, params })

/**
 * When each section can change, by the season's phase:
 * - teams, who runs them, awards and trade rules: any time;
 * - roster rules: any time but the draft (swaps move players by slot), and only if today's rosters fit them;
 * - the playoff format and tiebreakers: until the playoffs start (they seed them), then from the next preseason;
 * - draft settings: any time but the draft itself;
 * - structure: before the season's schedule exists (preseason) or in the offseason;
 * - games per season, how rounds are built and the calendar: preseason only (in the offseason they'd
 *   recount the season just played). One exception: a running regular season may switch its rounds
 *   to 2K 일정대로 once no built game waits unplayed (see playedSwitchLock); out of 2K 일정대로 is
 *   preseason only.
 */
export function sectionLocks(phase: Phase): Record<SettingsSection, SectionLock> {
  const between = phase === 'preseason' || phase === 'offseason'
  return {
    teams: OPEN,
    control: OPEN,
    awards: OPEN,
    trades: OPEN,
    roster: phase === 'draft' ? locked('settings-during-draft') : OPEN,
    playoffs: phase === 'preseason' || phase === 'regular' ? OPEN : locked('settings-playoffs-started', { phase }),
    draft: phase === 'draft' ? locked('settings-during-draft') : OPEN,
    structure: between ? OPEN : locked('settings-season-running', { phase }),
    schedule: phase === 'preseason' ? OPEN : locked(phase === 'offseason' ? 'settings-schedule-next' : 'settings-season-running', { phase }),
  }
}

/** Freezing or unfreezing a team: frozen teams sit out the draft, so not while it runs. */
export const freezeLock = (phase: Phase): SectionLock => (phase === 'draft' ? locked('settings-during-draft') : OPEN)

/** The draft system itself (없음 ↔ card swap): only between seasons, when no season's cards are in play. */
export const draftKindLock = (phase: Phase): SectionLock =>
  phase === 'preseason' || phase === 'offseason' ? OPEN : locked('settings-draft-kind', { phase })

/**
 * 2K 일정대로 mid-season: a running regular season built by rounds ('auto' or
 * 'manual') may switch to it once no built game waits unplayed (the rounds
 * played become sessions, and the next one opens after them). Null where the
 * switch isn't a thing: outside the regular season (in the preseason the
 * whole schedule is open), a custom game count, or 2K 일정대로 already.
 */
function playedSwitchLock(db: Db, season: SeasonInfo, config: LeagueConfig): SectionLock | null {
  const { schedule } = config.season
  if (season.phase !== 'regular' || schedule.kind !== 'round-robin' || schedule.build === 'played') return null
  const unplayed = unplayedRegularGames(db, season.id)
  return unplayed > 0 ? locked('settings-played-unplayed', { count: unplayed }) : OPEN
}

/** A save whose only schedule change is switching a round robin's build to 2K 일정대로 (same meetings, same calendar). */
function onlyToPlayed(before: LeagueConfig, after: LeagueConfig): boolean {
  const a = before.season.schedule
  const b = after.season.schedule
  return (
    a.kind === 'round-robin' &&
    b.kind === 'round-robin' &&
    a.build !== 'played' &&
    b.build === 'played' &&
    a.cycles === b.cycles &&
    JSON.stringify(before.season.calendar) === JSON.stringify(after.season.calendar)
  )
}

/** Cards every team already got this season: only while the season runs (they're handed out at its start). */
function issuedCards(db: Db, seasonId: number, phase: Phase): number {
  if (phase !== 'regular' && phase !== 'playoffs') return 0
  return (db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM cards WHERE issued_season_id = ?').get(seasonId) as { n: number }).n
}

/** Cards still held this season (carried over, or not yet played): switching the card draft off expires them. */
function heldCards(db: Db, seasonId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cards WHERE season_id = ? AND status = 'held'").get(seasonId) as { n: number }).n
}

/** How many held cards a save would expire (it switches the card draft off); 0 when none. */
export function cardsExpiring(db: Db, input: Pick<LeagueSettingsInput, 'draft'>): number {
  const { config } = loadConfig(db)
  if (config.draft.kind !== 'card-swap' || effectiveDraft(input.draft).kind === 'card-swap') return 0
  return heldCards(db, currentSeason(db).id)
}

function givenAwards(db: Db): SettingsState['givenAwards'] {
  const rows = db
    .prepare(
      `SELECT award_id, MAX(team_rank) AS max_rank, MAX(n) AS max_place, GROUP_CONCAT(DISTINCT period) AS periods
       FROM (SELECT award_id, team_rank, period, COUNT(*) AS n FROM awards GROUP BY season_id, award_id, period, team_rank)
       GROUP BY award_id ORDER BY award_id`,
    )
    .all() as { award_id: string; max_rank: number; max_place: number; periods: string | null }[]
  return rows.map((r) => ({
    id: r.award_id,
    maxRank: r.max_rank,
    maxPerPlace: r.max_place,
    periods: (r.periods ?? '').split(',').filter((p) => p !== ''),
  }))
}

/** What the settings screen needs to show which sections it may change now, and why not. */
export function settingsState(db: Db): SettingsState {
  const season = currentSeason(db)
  return {
    phase: season.phase,
    locks: sectionLocks(season.phase),
    freeze: freezeLock(season.phase),
    draftKind: draftKindLock(season.phase),
    givenAwards: givenAwards(db),
    issuedCards: issuedCards(db, season.id, season.phase),
    heldCards: heldCards(db, season.id),
    playedSwitch: playedSwitchLock(db, season, loadConfig(db).config),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Award definitions that changed must still hold every time they were given:
 * a given award can't go (it'd lose its name in the history; rename it), and
 * its places, winners per place and period must still fit what was given.
 */
function awardIssues(before: LeagueConfig['awards'], after: LeagueConfig['awards'], given: SettingsState['givenAwards']): RuleIssue[] {
  const issues: RuleIssue[] = []
  const all = (a: LeagueConfig['awards']) => [...a.season, ...a.periodic]
  for (const g of given) {
    const old = all(before).find((a) => a.id === g.id)
    const season = after.season.find((a) => a.id === g.id)
    const periodic = after.periodic.find((a) => a.id === g.id)
    // An id left in the history from a definition removed long ago isn't this save's business.
    if (!old) continue
    if (!season && !periodic) {
      issues.push({ code: 'settings-award-given', params: { award: old.name } })
      continue
    }
    if (same(old, season ?? periodic)) continue
    let fits: boolean
    if (season) {
      const places = season.kind === 'selection' ? season.teams : 1
      const perPlace = season.kind === 'selection' ? season.perTeam : 1
      fits = g.maxRank <= places && g.maxPerPlace <= perPlace && g.periods.length === 0
    } else {
      const letter = periodic!.period === 'week' ? 'w' : 'm'
      fits = g.maxRank <= 1 && g.maxPerPlace <= periodic!.winners && g.periods.every((p) => new RegExp(`^${letter}\\d+$`).test(p))
    }
    if (!fits) issues.push({ code: 'settings-award-shape', params: { award: (season ?? periodic)!.name } })
  }
  return issues
}

/** A checked save, ready to commit. */
export interface PreparedSettings {
  config: LeagueConfig
  configChanged: boolean
  /** The card draft was switched off: cards still held (carried over) have no draft to be played in. */
  cardDraftOff: boolean
  /** A running regular season switched to 2K 일정대로: the rounds already played close as sessions. */
  toPlayed?: boolean
  teams: Team[]
  changed: SettingsSection[]
  renamed: { teamId: string; from: string; to: string }[]
  /** Per team, the fields that changed (name, shortName, colors, divisionId, control). */
  teamChanges: { teamId: string; fields: string[]; renamedFrom?: string }[]
}

const issueKey = (i: SetupIssue) => `${i.code}|${JSON.stringify(i.path)}|${JSON.stringify(i.params)}`

/**
 * Checks a settings save without changing anything: teams are the same ones,
 * each changed section is open now, and the whole setup passes the wizard's
 * check with today's players (problems the league already had don't block
 * an unrelated change). Throws RuleError (timing, awards, cards) or
 * SetupError (the setup check).
 */
export function checkSettings(db: Db, input: LeagueSettingsInput): PreparedSettings {
  const { config } = loadConfig(db)
  const season = currentSeason(db)
  const teams = listTeams(db)
  const players = listPlayers(db).map(({ heightCm: _, ...p }) => p)

  // The same teams, in their own order: teams are never added or removed here.
  const byId = new Map(input.teams.map((t) => [t.id, t]))
  if (input.teams.length !== teams.length || byId.size !== teams.length || teams.some((t) => !byId.has(t.id))) refuse('settings-teams-fixed')
  const nextTeamsRaw = teams.map((t) => byId.get(t.id)!)

  const nextConfigRaw = applySettings(config, { ...input, draft: effectiveDraft(input.draft) })
  const parsed = leagueSetupSchema.safeParse({ config: nextConfigRaw, teams: nextTeamsRaw, players })
  if (!parsed.success) throw new SetupError(validateSetup({ config: nextConfigRaw, teams: nextTeamsRaw, players }))
  const next = parsed.data
  // Errors the league already had (an old import, say) don't block a change that didn't cause them.
  const before = new Set(validateSetup({ config, teams, players }).filter((i) => i.level === 'error').map(issueKey))
  const fresh = validateSetup(next).filter((i) => i.level === 'error' && !before.has(issueKey(i)))
  if (hasErrors(fresh)) throw new SetupError(fresh)

  const prev = new Map(teams.map((t) => [t.id, t]))
  const teamChanges: PreparedSettings['teamChanges'] = []
  const renamed: PreparedSettings['renamed'] = []
  for (const t of next.teams) {
    const old = prev.get(t.id)!
    const fields = (['name', 'shortName', 'colors', 'divisionId', 'control'] as const).filter((k) => !same(old[k], t[k]))
    if (fields.length === 0) continue
    teamChanges.push({ teamId: t.id, fields, ...(old.shortName !== t.shortName ? { renamedFrom: old.shortName } : {}) })
    if (old.shortName !== t.shortName) renamed.push({ teamId: t.id, from: old.shortName, to: t.shortName })
  }
  const c = next.config
  const was = config
  const changed = new Set(changedSections(settingsOf(was, teams), settingsOf(c, next.teams)))

  // Timing: every changed section must be open now.
  const issues: RuleIssue[] = []
  const locks = sectionLocks(season.phase)
  // 2K 일정대로 has its own times: into it mid-season once no built game waits unplayed, out of it only in the preseason.
  const switchLock = onlyToPlayed(was, c) ? playedSwitchLock(db, season, was) : null
  const leaving = playedMode(was) && !playedMode(c) && season.phase !== 'preseason' ? locked('settings-played-leave', { phase: season.phase }) : null
  for (const s of changed) {
    const lock = s === 'schedule' ? (leaving ?? (locks.schedule.open ? OPEN : (switchLock ?? locks.schedule))) : locks[s]
    if (!lock.open) issues.push({ code: lock.code!, params: { ...lock.params, section: s } })
  }
  const freezing = next.teams.filter((t) => (prev.get(t.id)!.control === 'frozen') !== (t.control === 'frozen'))
  const freeze = freezeLock(season.phase)
  if (freezing.length > 0 && !freeze.open) issues.push({ code: freeze.code!, params: { ...freeze.params, section: 'control' } })
  // A frozen team sits out the draft: a card it got from another team would stall the draft on its turn,
  // and one it gave away could never be played. Its own cards just sit out with it.
  const crossed = db.prepare(
    `SELECT COUNT(*) AS n FROM cards WHERE season_id = ? AND status = 'held'
     AND ((owner_team_id = ? AND original_team_id <> ?) OR (original_team_id = ? AND owner_team_id <> ?))`,
  )
  for (const t of freezing) {
    if (t.control === 'frozen' && (crossed.get(season.id, t.id, t.id, t.id, t.id) as { n: number }).n > 0) {
      issues.push({ code: 'settings-freeze-cards', params: { team: t.shortName } })
    }
  }
  if (effectiveDraft(was.draft).kind !== c.draft.kind) {
    const lock = draftKindLock(season.phase)
    if (!lock.open) issues.push({ code: lock.code!, params: lock.params })
  }
  // Cards handed out at the season's start can't be taken back: the lowest tier can't go below them.
  const issued = issuedCards(db, season.id, season.phase)
  if (changed.has('draft') && issued > 0 && c.draft.kind === 'card-swap' && guaranteedCards(c, teams.length) < issued) {
    issues.push({ code: 'settings-cards-issued', params: { count: issued } })
  }
  if (changed.has('awards')) issues.push(...awardIssues(was.awards, c.awards, givenAwards(db)))
  // A school's short name is its lore folder: its own file and its GM's are named after it, so no player may be.
  const playerNames = new Set(players.map((p) => folderKey(p.name)))
  for (const r of renamed) {
    if (playerNames.has(folderKey(r.to)) || playerNames.has(folderKey(`${r.to} 단장`))) issues.push({ code: 'settings-team-name-player', params: { name: r.to } })
  }
  if (issues.length > 0) throw new RuleError(issues)

  return {
    config: c,
    configChanged: !same(was, c),
    cardDraftOff: was.draft.kind === 'card-swap' && c.draft.kind !== 'card-swap',
    toPlayed: season.phase === 'regular' && onlyToPlayed(was, c),
    teams: next.teams,
    changed: [...changed],
    renamed,
    teamChanges,
  }
}

function refuse(code: string, params: RuleIssue['params'] = {}): never {
  throw new RuleError([{ code, params }])
}

/**
 * Writes a checked save in one transaction: a new config version when the
 * config changed, the teams, and (mid-season) any cards the new guaranteed
 * count or an unfrozen team still needs, so they can be traded like the rest.
 */
export function commitSettings(db: Db, prepared: PreparedSettings): Pick<SettingsSaveResult, 'version' | 'changed' | 'renamed' | 'cardsAdded' | 'cardsExpired'> {
  const season = currentSeason(db)
  return transaction(db, () => {
    const version = prepared.configChanged ? updateConfig(db, prepared.config, prepared.changed) : null
    // Rounds already played become 2K 일정대로 sessions, all closed; the next one opens after them.
    if (prepared.toPlayed && season.phase === 'regular') closeSwitchedRounds(db, season.id)
    // No draft will play them, and they'd otherwise carry over season after season.
    const cardsExpired = prepared.cardDraftOff
      ? Number(db.prepare("UPDATE cards SET status = 'expired' WHERE season_id = ? AND status = 'held'").run(season.id).changes)
      : 0
    if (prepared.teamChanges.length > 0) {
      const update = db.prepare('UPDATE teams SET name = ?, short_name = ?, division_id = ?, control = ?, colors = ? WHERE id = ?')
      for (const t of prepared.teams) update.run(t.name, t.shortName, t.divisionId, t.control, JSON.stringify(t.colors), t.id)
      appendEvent(db, 'teams_edited', { teams: prepared.teamChanges }, season.id)
    }
    let cardsAdded = 0
    if ((season.phase === 'regular' || season.phase === 'playoffs') && prepared.config.draft.kind === 'card-swap') {
      const guaranteed = guaranteedCards(prepared.config, prepared.teams.length)
      const have = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM cards WHERE issued_season_id = ? AND original_team_id = ?')
      const insert = db.prepare(
        "INSERT INTO cards (season_id, issued_season_id, original_team_id, owner_team_id, number, status) VALUES (?, ?, ?, ?, ?, 'held')",
      )
      for (const t of prepared.teams) {
        if (t.control === 'frozen') continue
        for (let n = (have.get(season.id, t.id) as { n: number }).n + 1; n <= guaranteed; n++) {
          insert.run(season.id, season.id, t.id, t.id, n)
          cardsAdded++
        }
      }
      if (cardsAdded > 0) appendEvent(db, 'cards_allocated', { cards: cardsAdded }, season.id)
    }
    return { version, changed: prepared.changed, renamed: prepared.renamed, cardsAdded, cardsExpired }
  })
}
