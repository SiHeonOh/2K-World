import { useState } from 'react'
import { useNavigate } from 'react-router'
import { isValidSlug } from '@shared/league'
import type { SetupIssue, SetupSection } from '@shared/setup'
import { ApiError, call } from '../../../api'
import { Check, ErrorBox, Field, IssueList, Notice, TextInput } from '../../../components/ui'
import { t } from '../../../i18n'
import { issueText } from '../StepIssues'
import { importIsStale, STEP_SECTIONS, STEPS, type StepId, type StepProps } from '../state'

const stepOf = (section: SetupSection): StepId =>
  STEPS.find((s) => STEP_SECTIONS[s].includes(section)) ?? 'review'

export function ReviewStep({ state, edit, issues, folder, goTo }: StepProps & { goTo: (s: StepId) => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [serverIssues, setServerIssues] = useState<SetupIssue[] | null>(null)
  const { config, teams, players } = state.setup
  const r = t.wizard.review

  const shown = serverIssues ?? issues
  const errors = shown.filter((i) => i.level === 'error')
  const warnings = shown.filter((i) => i.level === 'warning')
  const slugProblem = !isValidSlug(state.slug) ? t.wizard.league.slugBad : folder?.hasDb ? t.wizard.league.slugTaken : null
  const canCreate = errors.length === 0 && slugProblem === null && config.league.name.trim() !== ''

  const create = async () => {
    setBusy(true)
    setError(null)
    setServerIssues(null)
    try {
      const result = await call('leagues.create', {
        slug: state.slug,
        setup: state.setup,
        saveTemplate: state.saveTemplate.enabled
          ? { name: state.saveTemplate.name.trim() || config.league.name, includePlayers: state.saveTemplate.includePlayers }
          : null,
        // The mapping that produced the players, not one edited since.
        importMapping: state.importedMapping,
      })
      navigate(`/l/${encodeURIComponent(result.slug)}`)
    } catch (e) {
      if (e instanceof ApiError && e.shape.issues) setServerIssues(e.shape.issues)
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const control = (c: 'ai' | 'user' | 'frozen') => teams.filter((tm) => tm.control === c).length
  const { playoffs, schedule } = config.season
  const lines: [string, string][] = [
    [r.lines.league, `${config.league.name || '–'} · ${config.season.label}`],
    [r.lines.folder, state.slug || '–'],
    [
      r.lines.structure,
      `${config.structure.conferences.map((c) => c.name).join(', ') || '–'} / ${config.structure.divisions.map((d) => d.name).join(', ')} · ${teams.length}`,
    ],
    [r.lines.roster, `${config.roster.slots.map((s) => s.name).join(', ')} · ${players.length}`],
    [r.lines.ratings, config.ratings.columns.map((c) => c.name).join(', ')],
    [
      r.lines.schedule,
      schedule.kind === 'round-robin'
        ? `${t.wizard.season.kinds['round-robin']} ×${schedule.cycles} · ${t.wizard.season.builds[schedule.build]}`
        : `${t.wizard.season.gamesPerTeam} ${schedule.gamesPerTeam}`,
    ],
    [
      r.lines.playoffs,
      playoffs.enabled
        ? `${t.wizard.season.brackets[playoffs.bracket]} · ${playoffs.directSeeds}${playoffs.playIn.enabled ? ` + ${t.wizard.season.playIn}` : ''} · ${t.wizard.season.bestOf(playoffs.seriesBestOf)} · ${t.wizard.season.finalsKinds[playoffs.finals.kind]}`
        : t.app.none,
    ],
    [r.lines.awards, [...config.awards.season, ...config.awards.periodic].map((a) => a.name).join(', ') || t.app.none],
    [r.lines.trades, config.trades.enabled ? config.trades.phases.map((p) => t.wizard.rules.phaseNames[p]).join(', ') : t.app.none],
    [r.lines.draft, t.wizard.rules.draftKinds[config.draft.kind]],
    [r.lines.control, t.wizard.gm.counts(control('ai'), control('user'), control('frozen'))],
  ]

  const withLink = (i: SetupIssue) => ({
    level: i.level,
    text: issueText(i),
    action: (
      <button className="btn ghost small" onClick={() => goTo(stepOf(i.section))}>
        {r.goTo(t.wizard.steps[stepOf(i.section)])}
      </button>
    ),
  })

  return (
    <>
      <div className="card">
        <h2>{t.wizard.steps.review}</h2>
        <p className="help">{r.intro}</p>
        <table className="data">
          <tbody>
            {lines.map(([k, v]) => (
              <tr key={k}>
                <th style={{ width: 140, position: 'static' }}>{k}</th>
                <td className="wrap">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        {slugProblem ? <Notice tone="err">{slugProblem}</Notice> : null}
        {importIsStale(state) ? (
          <Notice tone="warn">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{r.importStale}</span>
              <button className="btn ghost small" onClick={() => goTo('import')}>
                {r.goTo(t.wizard.steps.import)}
              </button>
            </div>
          </Notice>
        ) : null}
        {errors.length === 0 && warnings.length === 0 && !slugProblem ? <Notice tone="ok">{r.noIssues}</Notice> : null}
        {errors.length > 0 ? (
          <>
            <h3>
              {r.errors} ({errors.length})
            </h3>
            <IssueList items={errors.slice(0, 30).map(withLink)} />
          </>
        ) : null}
        {warnings.length > 0 ? (
          <>
            <h3>
              {r.warnings} ({warnings.length})
            </h3>
            <IssueList items={warnings.slice(0, 30).map(withLink)} />
          </>
        ) : null}
      </div>

      <div className="card">
        <Check checked={state.saveTemplate.enabled} onChange={(v) => edit((s) => void (s.saveTemplate.enabled = v))}>
          {r.saveTemplate}
        </Check>
        {state.saveTemplate.enabled ? (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={r.templateName}>
              {(id) => (
                <TextInput
                  id={id}
                  value={state.saveTemplate.name}
                  width={280}
                  onChange={(v) => edit((s) => void (s.saveTemplate.name = v))}
                />
              )}
            </Field>
            <Check checked={state.saveTemplate.includePlayers} onChange={(v) => edit((s) => void (s.saveTemplate.includePlayers = v))}>
              {r.includePlayers}
            </Check>
          </div>
        ) : null}
      </div>

      {error ? <ErrorBox error={error} /> : null}
      <div className="wizard-nav">
        <button className="btn" onClick={() => goTo('gm')}>
          {t.app.back}
        </button>
        <button className="btn primary" disabled={!canCreate || busy} onClick={() => void create()}>
          {busy ? r.creating : r.create}
        </button>
      </div>
    </>
  )
}
