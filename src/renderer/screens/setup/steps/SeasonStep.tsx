import type { Tiebreaker } from '@shared/config/schema'
import { Check, Field, NumberInput, RowControls, Segmented, Select, TextInput, move } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { Edit, StepProps, WizardState } from '../state'

const TIEBREAKERS: Tiebreaker[] = ['head-to-head', 'point-diff', 'points-for', 'conference-record', 'division-record', 'random']
const BEST_OF = [1, 3, 5, 7, 9]
const bestOfOptions = () => BEST_OF.map((n) => ({ value: String(n), label: t.wizard.season.bestOf(n) }))

interface CardProps {
  state: WizardState
  edit: Edit
}

/** Games per season and how rounds are built. `showLabel`: the first season's name (only when creating a league). */
export function ScheduleCard({ state, edit, showLabel = true }: CardProps & { showLabel?: boolean }) {
  const { season } = state.setup.config
  const { schedule } = season
  const teamCount = state.setup.teams.length
  const perTeam = schedule.kind === 'round-robin' ? Math.max(0, teamCount - 1) * schedule.cycles : schedule.gamesPerTeam
  const total = Math.floor((perTeam * teamCount) / 2)
  return (
    <div className="card">
      <h2>{t.wizard.season.schedule}</h2>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {showLabel ? (
          <Field label={t.wizard.season.label}>
            {(id) => <TextInput id={id} value={season.label} onChange={(v) => edit((s) => void (s.setup.config.season.label = v))} />}
          </Field>
        ) : null}
        <Field label={t.wizard.season.scheduleKind}>
          <Segmented
            value={schedule.kind}
            options={(['round-robin', 'custom'] as const).map((v) => ({ value: v, label: t.wizard.season.kinds[v] }))}
            onChange={(v) =>
              edit((s) => {
                // Same kind again would reset its numbers.
                if (s.setup.config.season.schedule.kind === v) return
                s.setup.config.season.schedule =
                  v === 'round-robin' ? { kind: 'round-robin', cycles: 1, build: 'auto' } : { kind: 'custom', gamesPerTeam: Math.max(1, perTeam) }
              })
            }
          />
        </Field>
        {schedule.kind === 'round-robin' ? (
          <>
            <Field label={t.wizard.season.cycles} help={t.wizard.season.cyclesHelp}>
              {(id) => (
                <NumberInput
                  id={id}
                  value={schedule.cycles}
                  min={1}
                  max={8}
                  onChange={(v) => edit((s) => void (s.setup.config.season.schedule = { kind: 'round-robin', cycles: Math.max(1, v), build: schedule.build }))}
                />
              )}
            </Field>
            <Field label={t.wizard.season.build} help={t.wizard.season.buildHelp[schedule.build]}>
              <Segmented
                value={schedule.build}
                options={(['auto', 'manual', 'played'] as const).map((v) => ({ value: v, label: t.wizard.season.builds[v] }))}
                onChange={(v) => edit((s) => void (s.setup.config.season.schedule = { kind: 'round-robin', cycles: schedule.cycles, build: v }))}
              />
            </Field>
          </>
        ) : (
          <Field label={t.wizard.season.gamesPerTeam}>
            {(id) => (
              <NumberInput
                id={id}
                value={schedule.gamesPerTeam}
                min={1}
                max={200}
                onChange={(v) => edit((s) => void (s.setup.config.season.schedule = { kind: 'custom', gamesPerTeam: Math.max(1, v) }))}
              />
            )}
          </Field>
        )}
      </div>
      {teamCount > 1 ? <p className="help">{t.wizard.season.computed(perTeam, total)}</p> : null}
    </div>
  )
}

/** Tiebreakers, in order after win %. They seed the playoffs and set the draft order. */
export function StandingsCard({ state, edit }: CardProps) {
  const { standings } = state.setup.config.season
  const unused = TIEBREAKERS.filter((tb) => !standings.tiebreakers.includes(tb))
  return (
    <div className="card">
      <h2>{t.wizard.season.standings}</h2>
      <p className="help">{t.wizard.season.standingsHelp}</p>
      <div className="list-editor">
        {standings.tiebreakers.map((tb, i) => (
          <div key={tb} className="item">
            <span className="badge">{i + 1}</span>
            <span style={{ minWidth: 220 }}>{t.wizard.season.tiebreakers[tb]}</span>
            <RowControls
              index={i}
              count={standings.tiebreakers.length}
              onMove={(from, to) => edit((s) => move(s.setup.config.season.standings.tiebreakers, from, to))}
              onRemove={() => edit((s) => void s.setup.config.season.standings.tiebreakers.splice(i, 1))}
            />
          </div>
        ))}
      </div>
      {unused.length > 0 ? (
        <div className="row">
          <span className="muted">{t.wizard.season.addTiebreaker}:</span>
          {unused.map((tb) => (
            <button key={tb} className="btn small" onClick={() => edit((s) => void s.setup.config.season.standings.tiebreakers.push(tb))}>
              + {t.wizard.season.tiebreakers[tb]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The playoff format: bracket, seeds, play-in and series lengths, the finals. */
export function PlayoffsCard({ state, edit }: CardProps) {
  const { season, structure } = state.setup.config
  const { playoffs } = season
  const field = playoffs.directSeeds + (playoffs.playIn.enabled ? 2 : 0)
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t.wizard.season.playoffs}</h2>
        <Check checked={playoffs.enabled} onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.enabled = v))}>
          {t.wizard.season.playoffsEnabled}
        </Check>
      </div>
      {playoffs.enabled ? (
        <>
          <div className="grid-3">
            <Field label={t.wizard.season.bracket}>
              <Segmented
                value={playoffs.bracket}
                options={(['conference', 'league'] as const).map((v) => ({ value: v, label: t.wizard.season.brackets[v] }))}
                onChange={(v) =>
                  edit((s) => {
                    const p = s.setup.config.season.playoffs
                    p.bracket = v
                    if (v === 'league') p.finals.kind = 'none'
                  })
                }
              />
            </Field>
            <Field label={t.wizard.season.directSeeds} help={t.wizard.season.directSeedsHelp}>
              {(id) => (
                <NumberInput
                  id={id}
                  value={playoffs.directSeeds}
                  min={1}
                  max={64}
                  onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.directSeeds = Math.max(1, v)))}
                />
              )}
            </Field>
            <Field label={t.wizard.season.seriesBestOf}>
              {(id) => (
                <Select
                  id={id}
                  value={String(playoffs.seriesBestOf)}
                  options={bestOfOptions()}
                  onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.seriesBestOf = Number(v)))}
                />
              )}
            </Field>
          </div>
          <div className="grid-3">
            <Field label={t.wizard.season.playIn} help={t.wizard.season.playInHelp}>
              <Check checked={playoffs.playIn.enabled} onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.playIn.enabled = v))}>
                {t.app.yes}
              </Check>
            </Field>
            {playoffs.playIn.enabled ? (
              <Field label={t.wizard.season.playInBestOf}>
                {(id) => (
                  <Select
                    id={id}
                    value={String(playoffs.playIn.bestOf)}
                    options={bestOfOptions()}
                    onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.playIn.bestOf = Number(v)))}
                  />
                )}
              </Field>
            ) : (
              <span />
            )}
            <span />
          </div>
          <div className="grid-3">
            <Field label={t.wizard.season.finals}>
              {(id) => (
                <Select
                  id={id}
                  value={playoffs.finals.kind}
                  options={(['conference-champions', 'none'] as const).map((v) => ({ value: v, label: t.wizard.season.finalsKinds[v] }))}
                  onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.finals.kind = v))}
                />
              )}
            </Field>
            {playoffs.finals.kind === 'conference-champions' ? (
              <Field label={t.wizard.season.finalsBestOf}>
                {(id) => (
                  <Select
                    id={id}
                    value={String(playoffs.finals.bestOf)}
                    options={bestOfOptions()}
                    onChange={(v) => edit((s) => void (s.setup.config.season.playoffs.finals.bestOf = Number(v)))}
                  />
                )}
              </Field>
            ) : null}
          </div>
          <p className="help">{t.wizard.season.field(field, playoffs.bracket === 'conference' ? structure.conferences.length : 0)}</p>
        </>
      ) : null}
    </div>
  )
}

/** How many rounds make a week and weeks a month (weekly and monthly awards, round-ups). */
export function CalendarCard({ state, edit }: CardProps) {
  const { calendar } = state.setup.config.season
  return (
    <div className="card">
      <h2>{t.wizard.season.calendar}</h2>
      <p className="help">{t.wizard.season.calendarHelp}</p>
      <div className="row">
        <Field label={t.wizard.season.roundsPerWeek}>
          {(id) => (
            <NumberInput
              id={id}
              value={calendar.roundsPerWeek}
              min={1}
              max={50}
              onChange={(v) => edit((s) => void (s.setup.config.season.calendar.roundsPerWeek = Math.max(1, v)))}
            />
          )}
        </Field>
        <Field label={t.wizard.season.weeksPerMonth}>
          {(id) => (
            <NumberInput
              id={id}
              value={calendar.weeksPerMonth}
              min={1}
              max={10}
              onChange={(v) => edit((s) => void (s.setup.config.season.calendar.weeksPerMonth = Math.max(1, v)))}
            />
          )}
        </Field>
      </div>
    </div>
  )
}

export function SeasonStep({ state, edit, issues }: StepProps) {
  return (
    <>
      <ScheduleCard state={state} edit={edit} />
      <StandingsCard state={state} edit={edit} />
      <PlayoffsCard state={state} edit={edit} />
      <CalendarCard state={state} edit={edit} />
      <StepIssues issues={issues} sections={['season']} />
    </>
  )
}
