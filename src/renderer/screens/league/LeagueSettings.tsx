import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { TeamControl } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { applySettings, changedSections, effectiveDraft, SETTINGS_SECTIONS, settingsOf, type SectionLock, type SettingsSaveResult, type SettingsSection, type SettingsState } from '@shared/settings'
import { validateSetup, type SetupIssue } from '@shared/setup'
import { ApiError, call } from '../../api'
import { Badge, IssueList, Loading, Notice, Segmented, Select, TextInput } from '../../components/ui'
import { useDraft, useLoad } from '../../hooks'
import { t } from '../../i18n'
import { initialState, type Edit, type WizardState } from '../setup/state'
import { issueText } from '../setup/StepIssues'
import { PeriodicAwardsCard, SeasonAwardsCard } from '../setup/steps/AwardsStep'
import { RatingLabelsCard, SlotsCard } from '../setup/steps/RosterStep'
import { DraftCard, TradesCard } from '../setup/steps/RulesStep'
import { CalendarCard, PlayoffsCard, ScheduleCard, StandingsCard } from '../setup/steps/SeasonStep'
import { ConferencesCard, DivisionsCard } from '../setup/steps/StructureStep'
import { useLeague } from './LeagueLayout'
import { PlayedSwitch } from './Played'
import { RuleErrors, ruleText } from './RuleErrors'

const ts = t.leagueSettings
const CONTROLS: TeamControl[] = ['ai', 'user', 'frozen']

/** The league's settings as the wizard's forms edit them (players come along only for the checks). */
function fromLeague(league: LeagueSnapshot): WizardState {
  const config = applySettings(league.config, settingsOf(league.config, league.teams))
  const players = league.players.map(({ heightCm: _, ...p }) => p)
  return { ...initialState(league.slug), setup: structuredClone({ config, teams: league.teams, players }) }
}

const issueKey = (i: SetupIssue) => `${i.code}|${JSON.stringify(i.path)}|${JSON.stringify(i.params)}`

/**
 * 편집실 → 리그 설정: the league's teams and rules after it exists, in the
 * wizard's own forms. Each section says when it can change and is locked
 * otherwise; the main process checks the same again (and the wizard's setup
 * check) and makes a backup before it saves.
 */
export function LeagueSettings() {
  const { league, reload, refreshing } = useLeague()
  const state = useLoad(() => call('leagues.settingsState', league.slug), [league.slug, league.season.phase, league.stamp], { keepPrevious: true })
  const [draft, edit, reset] = useDraft<WizardState>(() => fromLeague(league))
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<SettingsSaveResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const busy = saving || refreshing

  // After a save, the reloaded league is the new starting point.
  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(fromLeague(league))
    setSaving(false)
  }, [league, refreshing, reset])

  const before = useMemo(() => settingsOf(league.config, league.teams), [league])
  const after = settingsOf(draft.setup.config, draft.setup.teams)
  const changed = changedSections(before, after)
  // Problems the league already had don't block a change that didn't cause them (the server agrees).
  const known = useMemo(() => new Set(validateSetup(fromLeague(league).setup).map(issueKey)), [league])
  const issues = useMemo(() => validateSetup(draft.setup).filter((i) => !known.has(issueKey(i))), [draft.setup, known])
  const errors = issues.filter((i) => i.level === 'error')
  const locks = state.state === 'ready' ? state.value : null
  const lockedChanged = locks ? changed.filter((s) => !locks.locks[s].open) : []
  const original = useMemo(() => new Map(league.teams.map((tm) => [tm.id, tm])), [league.teams])
  const renaming = draft.setup.teams.some((tm) => original.get(tm.id)?.shortName !== tm.shortName)
  // Switching the card draft off expires the cards still held: asked first, as they can't come back but by a restore.
  const expiring = locks && effectiveDraft(before.draft).kind === 'card-swap' && effectiveDraft(after.draft).kind !== 'card-swap' ? locks.heldCards : 0

  const save = async () => {
    if (busy || changed.length === 0 || errors.length > 0 || lockedChanged.length > 0) return
    if (renaming && !window.confirm(ts.confirmRename)) return
    if (expiring > 0 && !window.confirm(ts.confirmCardsExpire(expiring))) return
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      setResult(await call('leagues.saveSettings', league.slug, after))
      savedFrom.current = league
      reload()
      state.reload()
    } catch (e) {
      setError(e)
      setSaving(false)
    }
  }

  const sectionProps = (id: SettingsSection) => ({ id, lock: locks?.locks[id] ?? null, changed: changed.includes(id), busy })
  const given = new Set(locks?.givenAwards.map((a) => a.id) ?? [])
  const names = (list: SettingsSection[]) => list.map((s) => ts.sections[s]).join(', ')

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{ts.title}</h1>
          <p className="sub">{ts.phaseNow(t.office.phases[league.season.phase])}</p>
        </div>
        <Link className="btn" to={`/l/${encodeURIComponent(league.slug)}/editroom`}>
          {ts.back}
        </Link>
      </div>
      <p className="help">{ts.intro}</p>
      {state.state === 'loading' ? <Loading /> : null}
      {state.state === 'error' ? <RuleErrors error={state.error} onRetry={state.reload} /> : null}
      {locks ? <WhenTable locks={locks} /> : null}

      <Section {...sectionProps('teams')} changed={changed.includes('teams') || changed.includes('control')} extra={locks && !locks.freeze.open ? ts.freezeNote : null}>
        <TeamsCard state={draft} edit={edit} structureOpen={locks?.locks.structure.open ?? false} freezeOpen={locks?.freeze.open ?? false} original={original} />
      </Section>

      <Section {...sectionProps('awards')}>
        <SeasonAwardsCard state={draft} edit={edit} given={given} />
        <PeriodicAwardsCard state={draft} edit={edit} given={given} />
      </Section>

      <Section {...sectionProps('trades')}>
        <TradesCard state={draft} edit={edit} />
        <p className="help">{ts.oncePerSeasonTip}</p>
      </Section>

      <Section {...sectionProps('labels')}>
        <RatingLabelsCard state={draft} edit={edit} />
      </Section>

      <Section {...sectionProps('roster')}>
        <SlotsCard state={draft} edit={edit} />
      </Section>

      <Section {...sectionProps('playoffs')}>
        <PlayoffsCard state={draft} edit={edit} />
        <StandingsCard state={draft} edit={edit} />
      </Section>

      <Section {...sectionProps('draft')}>
        <DraftCard
          state={draft}
          edit={edit}
          kindLocked={!(locks?.draftKind.open ?? false)}
          note={locks && locks.issuedCards > 0 ? ts.issuedCards(locks.issuedCards) : undefined}
        />
      </Section>

      <Section {...sectionProps('structure')}>
        <ConferencesCard state={draft} edit={edit} autoFit={locks?.locks.playoffs.open ?? false} fitAwards={false} />
        <DivisionsCard state={draft} edit={edit} />
      </Section>

      <Section {...sectionProps('schedule')}>
        <ScheduleCard state={draft} edit={edit} showLabel={false} />
        <CalendarCard state={draft} edit={edit} />
      </Section>
      {/* A running season built by rounds can still switch to 2K 일정대로 (saved on its own). */}
      {locks?.playedSwitch ? (
        <PlayedSwitch
          lock={locks.playedSwitch}
          disabled={busy || changed.length > 0}
          onSaved={(schedule) => {
            edit((s) => void (s.setup.config.season.schedule = schedule))
            reload()
            state.reload()
          }}
        />
      ) : null}

      <div className="settings-bar">
        <span className={changed.length > 0 ? '' : 'muted'}>{changed.length > 0 ? ts.changed(names(changed)) : ts.nothing}</span>
        {issues.length > 0 ? <IssueList items={issues.slice(0, 12).map((i) => ({ level: i.level, text: issueText(i) }))} /> : null}
        {errors.length > 0 ? <span className="help">{ts.blockedErrors}</span> : null}
        {lockedChanged.length > 0 ? <Notice tone="warn">{ts.blockedLocked(names(lockedChanged))}</Notice> : null}
        {error ? <SaveError error={error} /> : null}
        {result && changed.length === 0 && !busy ? <Saved result={result} /> : null}
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || changed.length === 0 || errors.length > 0 || lockedChanged.length > 0}
            onClick={() => void save()}
          >
            {saving ? ts.saving : ts.save}
          </button>
          <button
            className="btn ghost"
            disabled={busy || changed.length === 0}
            onClick={() => {
              if (window.confirm(ts.confirmUndo)) reset(fromLeague(league))
            }}
          >
            {ts.undo}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One part of the settings: when it can change, whether it can now (and why not), and its forms. */
function Section({
  id,
  lock,
  changed,
  busy,
  extra,
  children,
}: {
  id: SettingsSection
  lock: SectionLock | null
  changed: boolean
  busy: boolean
  extra?: string | null
  children: ReactNode
}) {
  return (
    <section className="settings-section" aria-label={ts.sections[id]}>
      <div className="section-head">
        <h2>{ts.sections[id]}</h2>
        <span className="row" style={{ gap: 8 }}>
          {changed ? <Badge tone="accent">{ts.edited}</Badge> : null}
          {lock ? <Badge tone={lock.open ? 'ok' : 'warn'}>{lock.open ? ts.openNow : ts.locked}</Badge> : null}
        </span>
      </div>
      <p className="help">{ts.rulesText[id]}</p>
      {lock && !lock.open ? <Notice tone="warn">{ruleText(lock.code!, lock.params)}</Notice> : null}
      {extra ? <Notice tone="info">{extra}</Notice> : null}
      <fieldset className="settings-body" disabled={!lock?.open || busy}>
        {children}
      </fieldset>
    </section>
  )
}

/** Every section and when it can change, with where things stand now. */
function WhenTable({ locks }: { locks: SettingsState }) {
  return (
    <div className="card flush">
      <div className="card-head" style={{ padding: '12px 16px' }}>
        <h2>{ts.when}</h2>
      </div>
      <div className="table-wrap">
        <table className="data settings-when">
          <tbody>
            {SETTINGS_SECTIONS.filter((s) => s !== 'control').map((s) => {
              const lock = locks.locks[s]
              return (
                <tr key={s}>
                  <td>
                    <b>{ts.sections[s]}</b>
                  </td>
                  <td>{ts.rulesText[s]}</td>
                  <td>{lock.open ? <Badge tone="ok">{ts.openNow}</Badge> : <Badge tone="warn">{ts.locked}</Badge>}</td>
                </tr>
              )
            })}
            <tr>
              <td>
                <b>{ts.sections.control}</b>
              </td>
              <td>{ts.rulesText.control}</td>
              <td>{locks.freeze.open ? <Badge tone="ok">{ts.openNow}</Badge> : <Badge tone="warn">{ts.freezeLocked}</Badge>}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Teams: names, short names (their lore folders follow), colours, who runs
 * each, and their division (only when the structure can change). While the
 * draft runs, no team can be frozen or unfrozen.
 */
function TeamsCard({
  state,
  edit,
  structureOpen,
  freezeOpen,
  original,
}: {
  state: WizardState
  edit: Edit
  structureOpen: boolean
  freezeOpen: boolean
  original: Map<string, { control: TeamControl }>
}) {
  const tt = ts.team
  const { teams, config } = state.setup
  const divisions = config.structure.divisions
  return (
    <div className="card flush">
      <div className="card-head" style={{ padding: '14px 16px' }}>
        <div>
          <h2>{tt.title}</h2>
          <p className="help">{tt.help}</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{tt.name}</th>
              <th>{tt.shortName}</th>
              <th>{tt.colors}</th>
              <th>{tt.division}</th>
              <th>{tt.control}</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((tm, i) => {
              const wasFrozen = original.get(tm.id)?.control === 'frozen'
              return (
                <tr key={tm.id}>
                  <td>
                    <TextInput compact ariaLabel={t.app.cellLabel(tm.shortName, tt.name)} value={tm.name} width={200} onChange={(v) => edit((s) => void (s.setup.teams[i]!.name = v))} />
                  </td>
                  <td>
                    <TextInput compact ariaLabel={t.app.cellLabel(tm.name, tt.shortName)} value={tm.shortName} width={120} onChange={(v) => edit((s) => void (s.setup.teams[i]!.shortName = v))} />
                  </td>
                  <td>
                    <span className="row settings-colors" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      {tm.colors.map((c, k) => (
                        <span key={k} className="row" style={{ gap: 0, flexWrap: 'nowrap' }}>
                          <input
                            type="color"
                            aria-label={t.app.cellLabel(tm.shortName, `${tt.colors} ${k + 1}`)}
                            value={c}
                            onChange={(e) => {
                              const v = e.target.value
                              edit((s) => void (s.setup.teams[i]!.colors[k] = v))
                            }}
                          />
                          <button type="button" className="btn ghost small icon" title={tt.removeColor} onClick={() => edit((s) => void s.setup.teams[i]!.colors.splice(k, 1))}>
                            ✕
                          </button>
                        </span>
                      ))}
                      {tm.colors.length < 4 ? (
                        <button type="button" className="btn ghost small" onClick={() => edit((s) => void s.setup.teams[i]!.colors.push('#888888'))}>
                          {tt.addColor}
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <Select
                      compact
                      disabled={!structureOpen}
                      ariaLabel={t.app.cellLabel(tm.shortName, tt.division)}
                      value={tm.divisionId}
                      options={divisions.map((d) => ({ value: d.id, label: d.name }))}
                      onChange={(v) => edit((s) => void (s.setup.teams[i]!.divisionId = v))}
                    />
                  </td>
                  <td>
                    {!freezeOpen && wasFrozen ? (
                      <span title={tt.frozenLocked}>
                        <Badge tone="info">{t.wizard.gm.controls.frozen}</Badge>
                      </span>
                    ) : (
                      <Segmented
                        ariaLabel={t.app.cellLabel(tm.shortName, tt.control)}
                        value={tm.control}
                        options={CONTROLS.filter((c) => freezeOpen || c !== 'frozen').map((c) => ({ value: c, label: t.wizard.gm.controls[c] }))}
                        onChange={(v) => edit((s) => void (s.setup.teams[i]!.control = v))}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A refused save: the engine's reasons, or the wizard's setup issues. */
function SaveError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'invalid-setup' && error.shape.issues) {
    return (
      <Notice tone="err">
        <IssueList items={error.shape.issues.map((i) => ({ level: i.level, text: issueText(i) }))} />
      </Notice>
    )
  }
  return <RuleErrors error={error} />
}

function Saved({ result }: { result: SettingsSaveResult }) {
  const lines = [
    ts.saved(result.version),
    ...result.renamed.map((r) => ts.renamed(r.from, r.to)),
    ...(result.renamed.length > 0 ? [ts.wikiNote(result.wikiUpdated)] : []),
    ...(result.cardsAdded > 0 ? [ts.cardsAdded(result.cardsAdded)] : []),
    ...(result.cardsExpired > 0 ? [ts.cardsExpired(result.cardsExpired)] : []),
  ]
  return (
    <Notice tone="ok">
      <div className="stack" style={{ gap: 4 }}>
        {lines.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </Notice>
  )
}
