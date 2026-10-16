import type { TeamControl } from '@shared/config/schema'
import { Check, Field, NumberInput, Segmented, Select } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { StepProps } from '../state'

const CONTROLS: TeamControl[] = ['ai', 'user', 'frozen']

export function GmStep({ state, edit, issues }: StepProps) {
  const { gm, structure } = state.setup.config
  const { teams } = state.setup
  const g = t.wizard.gm
  const count = (c: TeamControl) => teams.filter((tm) => tm.control === c).length
  const divisionName = new Map(structure.divisions.map((d) => [d.id, d.name]))

  return (
    <>
      <div className="card">
        <h2>{t.wizard.steps.gm}</h2>
        <p className="help">{g.intro}</p>
        <div className="grid-2">
          <Field label={g.autonomy} help={g.autonomyHelp}>
            {(id) => (
              <Select
                id={id}
                value={gm.autonomy}
                options={(['full', 'auto-within-limits', 'propose'] as const).map((v) => ({ value: v, label: g.autonomies[v] }))}
                onChange={(v) => edit((s) => void (s.setup.config.gm.autonomy = v))}
              />
            )}
          </Field>
          <Field label={g.windowEvery} help={g.windowEveryHelp}>
            {(id) => (
              <NumberInput
                id={id}
                value={gm.tradeWindowEveryRounds}
                min={0}
                max={100}
                onChange={(v) => edit((s) => void (s.setup.config.gm.tradeWindowEveryRounds = Math.max(0, v)))}
              />
            )}
          </Field>
          <Field label={g.negotiationLog}>
            {(id) => (
              <Select
                id={id}
                value={gm.negotiationLog}
                options={(['live', 'after-window'] as const).map((v) => ({ value: v, label: g.negotiationLogs[v] }))}
                onChange={(v) => edit((s) => void (s.setup.config.gm.negotiationLog = v))}
              />
            )}
          </Field>
          <Field label="">
            <Check checked={gm.rumorLeaks} onChange={(v) => edit((s) => void (s.setup.config.gm.rumorLeaks = v))}>
              {g.rumorLeaks}
            </Check>
          </Field>
        </div>
      </div>

      {teams.length > 0 ? (
        <div className="card flush">
          <div className="card-head" style={{ padding: '14px 16px' }}>
            <span className="muted">{g.counts(count('ai'), count('user'), count('frozen'))}</span>
            <button className="btn small" onClick={() => edit((s) => s.setup.teams.forEach((tm) => (tm.control = 'ai')))}>
              {g.allAi}
            </button>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.wizard.structure.shortName}</th>
                  <th>{t.wizard.structure.division}</th>
                  <th>{g.control}</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((tm, i) => (
                  <tr key={tm.id}>
                    <td>
                      <b>{tm.shortName}</b>
                    </td>
                    <td className="muted">{divisionName.get(tm.divisionId)}</td>
                    <td>
                      <Segmented
                        ariaLabel={t.app.cellLabel(tm.shortName, g.control)}
                        value={tm.control}
                        options={CONTROLS.map((c) => ({ value: c, label: g.controls[c] }))}
                        onChange={(v) => edit((s) => void (s.setup.teams[i]!.control = v))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <StepIssues issues={issues} sections={['gm']} />
    </>
  )
}
