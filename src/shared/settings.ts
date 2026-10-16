import { DEFAULT_VALUE_MODEL, type LeagueConfig, type Phase, type ValueModel } from './config/schema'
import type { Team } from './setup'

/**
 * League settings after the league exists (편집실 → 리그 설정). Each section
 * can change only at certain times of the season; the main process decides
 * (`src/data/settings.ts`) and refuses with a reason code otherwise.
 */

export const SETTINGS_SECTIONS = ['teams', 'control', 'awards', 'trades', 'labels', 'roster', 'playoffs', 'draft', 'structure', 'schedule'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * What the settings screen sends: the parts of the config it edits, and
 * every team (the same ids: teams are never added or removed here).
 * - teams: each team's full name, short name and colours;
 * - control: who runs each team (AI GM, you, or frozen);
 * - structure: conferences, divisions, and each team's division;
 * - schedule: games per season, how rounds are built, and the calendar;
 * - playoffs: the playoff format and the tiebreakers that seed it;
 * - labels (능력치): each rating column's Korean name ('' for the built-in
 *   one), its weight in player value, and the value model (OVR's share and
 *   how many of a player's best other ratings count). Only what's shown and
 *   how the AI GMs and moods read players change, so any time.
 */
export interface LeagueSettingsInput {
  structure: LeagueConfig['structure']
  /** Rating column id → the name shown for it; '' leaves it to the dictionary (shared/labels.ts). */
  ratingLabels: Record<string, string>
  /** Rating column id → its weight in player value (0: shown only); left out, the weights stay as they are. */
  ratingWeights?: Record<string, number>
  /** How value reads the headline rating; null: the defaults (OVR 55%, the best 6 others). Left out: as it is. */
  valueModel?: ValueModel | null
  roster: LeagueConfig['roster']
  schedule: LeagueConfig['season']['schedule']
  calendar: LeagueConfig['season']['calendar']
  standings: LeagueConfig['season']['standings']
  playoffs: LeagueConfig['season']['playoffs']
  awards: LeagueConfig['awards']
  trades: LeagueConfig['trades']
  draft: LeagueConfig['draft']
  teams: Team[]
}

/** Whether a section can change now; `code` (with `params`) says why not, translated in the renderer. */
export interface SectionLock {
  open: boolean
  code: string | null
  params: Record<string, string | number>
}

export interface SettingsState {
  phase: Phase
  locks: Record<SettingsSection, SectionLock>
  /** Freezing or unfreezing a team (frozen teams sit out the draft) has its own time: not during the draft. */
  freeze: SectionLock
  /** The draft system itself (없음 or the card swap) changes only between seasons. */
  draftKind: SectionLock
  /**
   * Awards given in any season, by id, with the most each was given (a rank
   * and how many in one place): a given award can be renamed, not removed,
   * and its shape must still hold every time it was given.
   */
  givenAwards: { id: string; maxRank: number; maxPerPlace: number; periods: string[] }[]
  /** Cards each team already got this season (the lowest tier can't go below it); 0 when none. */
  issuedCards: number
  /** Cards still held this season: switching the card draft off expires them (the screen asks first). */
  heldCards: number
  /**
   * Switching a running regular season to 2K 일정대로 (the rest of 일정 is locked
   * then): open when no built game waits unplayed, else why not. Null when it
   * doesn't apply (not the regular season, a custom game count, or already 2K 일정대로).
   */
  playedSwitch?: SectionLock | null
}

export interface SettingsSaveResult {
  /** The new config version; null when only teams changed (they aren't in the config). */
  version: number | null
  changed: SettingsSection[]
  /** Teams whose short name changed (it's also their lore folder's name). */
  renamed: { teamId: string; from: string; to: string }[]
  /** Lore folders and files the renames moved. */
  loreMoved: number
  /** Cards handed out now so every team holds the new guaranteed count. */
  cardsAdded: number
  /** Cards still held when the card draft was switched off: no draft will play them. */
  cardsExpired: number
  /** Wiki pages whose school category followed a renamed school. */
  wikiUpdated: number
}

/**
 * The sections a save changes. A team's name, short name and colours are
 * `teams`; who runs it is `control`; its division is `structure`.
 */
export function changedSections(before: LeagueSettingsInput, after: LeagueSettingsInput): SettingsSection[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const was = new Map(before.teams.map((t) => [t.id, t]))
  const team = (pick: (t: Team) => unknown) => after.teams.some((t) => !same(pick(t), was.has(t.id) ? pick(was.get(t.id)!) : undefined))
  const out: SettingsSection[] = []
  if (team((t) => [t.name, t.shortName, t.colors])) out.push('teams')
  if (team((t) => t.control)) out.push('control')
  if (!same(before.awards, after.awards)) out.push('awards')
  if (!same(before.trades, after.trades)) out.push('trades')
  const weights = after.ratingWeights !== undefined && !same(before.ratingWeights ?? {}, { ...before.ratingWeights, ...after.ratingWeights })
  const model = after.valueModel !== undefined && !same(modelOf(before.valueModel), modelOf(after.valueModel))
  if (!same(labelsOf(before.ratingLabels), labelsOf(after.ratingLabels)) || weights || model) out.push('labels')
  if (!same(before.roster, after.roster)) out.push('roster')
  if (!same(before.playoffs, after.playoffs) || !same(before.standings, after.standings)) out.push('playoffs')
  if (!same(effectiveDraft(before.draft), effectiveDraft(after.draft))) out.push('draft')
  if (!same(before.structure, after.structure) || team((t) => t.divisionId)) out.push('structure')
  if (!same(before.schedule, after.schedule) || !same(before.calendar, after.calendar)) out.push('schedule')
  return out
}

/** Labels as they'd be stored: trimmed, blanks left out. */
const labelsOf = (labels: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(labels ?? {}).flatMap(([id, l]) => (l.trim() ? [[id, l.trim()]] : [])))

/** A value model as it reads: the defaults for whatever it leaves out. */
const modelOf = (model: ValueModel | null | undefined): ValueModel => ({ ...DEFAULT_VALUE_MODEL, ...(model ?? {}) })

/** A value model as it's stored: left out when it's the defaults, so a league that never changed it has none. */
function storedModel(model: ValueModel | null | undefined): ValueModel | null {
  const m = modelOf(model)
  return m.overallShare === DEFAULT_VALUE_MODEL.overallShare && m.topCategories === DEFAULT_VALUE_MODEL.topCategories ? null : m
}

/** A draft setting the engine no longer runs ('standard' never had a draft): read as none. */
export function effectiveDraft(draft: LeagueConfig['draft']): LeagueConfig['draft'] {
  return draft.kind === 'standard' ? { kind: 'none' } : draft
}

/** The settings input as a league's config and teams stand now (the screen starts from this). */
export function settingsOf(config: LeagueConfig, teams: Team[]): LeagueSettingsInput {
  return {
    structure: config.structure,
    ratingLabels: Object.fromEntries(config.ratings.columns.map((c) => [c.id, c.label ?? ''])),
    ratingWeights: Object.fromEntries(config.ratings.columns.map((c) => [c.id, c.weight])),
    valueModel: config.ratings.valueModel ?? null,
    roster: config.roster,
    schedule: config.season.schedule,
    calendar: config.season.calendar,
    standings: config.season.standings,
    playoffs: config.season.playoffs,
    awards: config.awards,
    trades: config.trades,
    draft: effectiveDraft(config.draft),
    teams,
  }
}

/** The config with the settings' parts put in; everything else (community, AI, the league's name…) stays. */
export function applySettings(config: LeagueConfig, input: LeagueSettingsInput): LeagueConfig {
  const labels = labelsOf(input.ratingLabels)
  const weights = input.ratingWeights ?? {}
  const { valueModel: _model, ...ratings } = config.ratings
  const model = storedModel(input.valueModel === undefined ? config.ratings.valueModel : input.valueModel)
  return {
    ...config,
    // Names shown (a blank one goes back to the dictionary's), weights and the value model: how players are read, never the ratings.
    ratings: {
      ...ratings,
      columns: config.ratings.columns.map(({ label: _, ...c }) => {
        const weighed = typeof weights[c.id] === 'number' ? { ...c, weight: weights[c.id]! } : c
        return labels[c.id] ? { ...weighed, label: labels[c.id] } : weighed
      }),
      ...(model ? { valueModel: model } : {}),
    },
    structure: input.structure,
    roster: input.roster,
    season: { ...config.season, schedule: input.schedule, calendar: input.calendar, standings: input.standings, playoffs: input.playoffs },
    awards: input.awards,
    trades: input.trades,
    draft: input.draft,
  }
}
