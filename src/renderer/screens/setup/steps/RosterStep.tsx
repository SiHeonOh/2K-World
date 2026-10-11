import type { Edit, WizardState } from '../state'
import { Check, Field, NumberInput, RowControls, Segmented, Select, TextInput, move } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { StepProps } from '../state'

/** In one-per-slot mode the roster size is the slot count; keep them in step. */
function syncSize(s: WizardState) {
  const r = s.setup.config.roster
  if (r.slotMode === 'one-per-slot') {
    r.minPlayers = r.slots.length
    r.maxPlayers = r.slots.length
  }
}

export function RosterStep({ state, edit, issues }: StepProps) {
  const { ratings, playerFields } = state.setup.config

  return (
    <>
      <SlotsCard state={state} edit={edit} />
      <RatingsCards edit={edit} ratings={ratings} playerFields={playerFields} />
      <StepIssues issues={issues} sections={['roster', 'ratings', 'players']} />
    </>
  )
}

/** Roster rules: the slots, and how many players a team has (exactly one per slot, or a range). */
export function SlotsCard({ state, edit }: { state: WizardState; edit: Edit }) {
  const { roster } = state.setup.config
  return (
    <div className="card">
      <h2>{t.wizard.roster.slots}</h2>
      <p className="help">{t.wizard.roster.slotsHelp}</p>
      <Field label={t.wizard.roster.slotMode}>
        <Segmented
          value={roster.slotMode}
          options={(['one-per-slot', 'free'] as const).map((v) => ({ value: v, label: t.wizard.roster.slotModes[v] }))}
          onChange={(v) =>
            edit((s) => {
              s.setup.config.roster.slotMode = v
              syncSize(s)
            })
          }
        />
      </Field>
      {roster.slotMode === 'free' ? (
        <div className="row">
          <Field label={t.wizard.roster.minPlayers}>
            {(id) => (
              <NumberInput
                id={id}
                value={roster.minPlayers}
                min={1}
                max={30}
                onChange={(v) => edit((s) => void (s.setup.config.roster.minPlayers = v))}
              />
            )}
          </Field>
          <Field label={t.wizard.roster.maxPlayers}>
            {(id) => (
              <NumberInput
                id={id}
                value={roster.maxPlayers}
                min={1}
                max={30}
                onChange={(v) => edit((s) => void (s.setup.config.roster.maxPlayers = v))}
              />
            )}
          </Field>
        </div>
      ) : null}
      <div className="list-editor">
        {roster.slots.map((slot, i) => (
          <div key={slot.id} className="item">
            <code className="muted" style={{ width: 70 }}>
              {slot.id}
            </code>
            <TextInput
              ariaLabel={t.app.cellLabel(slot.id, t.wizard.roster.slotName)}
              value={slot.name}
              onChange={(v) => edit((s) => void (s.setup.config.roster.slots[i]!.name = v))}
            />
            <Check checked={slot.starter} onChange={(v) => edit((s) => void (s.setup.config.roster.slots[i]!.starter = v))}>
              {t.wizard.roster.starter}
            </Check>
            <RowControls
              index={i}
              count={roster.slots.length}
              onMove={(from, to) => edit((s) => move(s.setup.config.roster.slots, from, to))}
              onRemove={
                state.setup.players.some((p) => p.slotId === slot.id)
                  ? undefined
                  : () =>
                      edit((s) => {
                        s.setup.config.roster.slots.splice(i, 1)
                        syncSize(s)
                      })
              }
            />
          </div>
        ))}
      </div>
      <div>
        <button
          className="btn small"
          onClick={() =>
            edit((s) => {
              const slots = s.setup.config.roster.slots
              let n = slots.length + 1
              while (slots.some((x) => x.id === `slot-${n}`)) n++
              slots.push({ id: `slot-${n}`, name: t.wizard.roster.newSlot(n), starter: false })
              syncSize(s)
            })
          }
        >
          {t.wizard.roster.addSlot}
        </button>
      </div>
    </div>
  )
}

/** Rating columns, the grade scale and the height unit. */
function RatingsCards({
  edit,
  ratings,
  playerFields,
}: {
  edit: Edit
  ratings: WizardState['setup']['config']['ratings']
  playerFields: WizardState['setup']['config']['playerFields']
}) {
  return (
    <>
      <div className="card flush">
        <div style={{ padding: '14px 16px 0' }}>
          <h2>{t.wizard.roster.ratings}</h2>
          <p className="help">{t.wizard.roster.ratingsHelp}</p>
        </div>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>{t.wizard.roster.id}</th>
                <th>{t.wizard.roster.columnName}</th>
                <th>{t.wizard.roster.kind}</th>
                <th>{t.wizard.roster.min}</th>
                <th>{t.wizard.roster.max}</th>
                <th>{t.wizard.roster.weight}</th>
                <th className="center">{t.wizard.roster.overall}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ratings.columns.map((col, i) => (
                <tr key={col.id}>
                  <td>
                    <code className="muted">{col.id}</code>
                  </td>
                  <td>
                    <TextInput
                      compact
                      ariaLabel={t.app.cellLabel(col.id, t.wizard.roster.columnName)}
                      value={col.name}
                      onChange={(v) => edit((s) => void (s.setup.config.ratings.columns[i]!.name = v))}
                    />
                  </td>
                  <td>{t.wizard.roster.kinds[col.kind]}</td>
                  <td>
                    {col.kind === 'number' ? (
                      <NumberInput
                        compact
                        ariaLabel={t.app.cellLabel(col.name, t.wizard.roster.min)}
                        value={col.min}
                        onChange={(v) =>
                          edit((s) => {
                            const c = s.setup.config.ratings.columns[i]!
                            if (c.kind === 'number') c.min = v
                          })
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    {col.kind === 'number' ? (
                      <NumberInput
                        compact
                        ariaLabel={t.app.cellLabel(col.name, t.wizard.roster.max)}
                        value={col.max}
                        onChange={(v) =>
                          edit((s) => {
                            const c = s.setup.config.ratings.columns[i]!
                            if (c.kind === 'number') c.max = v
                          })
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    <NumberInput
                      compact
                      ariaLabel={t.app.cellLabel(col.name, t.wizard.roster.weight)}
                      value={col.weight}
                      min={0}
                      max={100}
                      step={0.5}
                      onChange={(v) => edit((s) => void (s.setup.config.ratings.columns[i]!.weight = Math.max(0, v)))}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="radio"
                      name="overall"
                      aria-label={t.app.cellLabel(col.name, t.wizard.roster.overall)}
                      checked={ratings.overallColumnId === col.id}
                      onChange={() => edit((s) => void (s.setup.config.ratings.overallColumnId = col.id))}
                    />
                  </td>
                  <td>
                    <RowControls index={i} count={ratings.columns.length} onMove={(from, to) => edit((s) => move(s.setup.config.ratings.columns, from, to))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>{t.wizard.roster.gradeScale}</h3>
          <p className="help">{t.wizard.roster.gradeScaleHelp}</p>
          <div className="row" style={{ gap: 6 }}>
            {ratings.gradeScale.map((g, i) => (
              <label key={i} className="stack" style={{ gap: 2, alignItems: 'center' }}>
                <b>{g.label}</b>
                <NumberInput
                  compact
                  value={g.value}
                  onChange={(v) => edit((s) => void (s.setup.config.ratings.gradeScale[i]!.value = v))}
                />
              </label>
            ))}
          </div>
        </div>
        <div className="card">
          <Field label={t.wizard.roster.height}>
            {(id) => (
              <Select
                id={id}
                value={playerFields.heightUnit}
                options={(['ft-in', 'cm'] as const).map((v) => ({ value: v, label: t.wizard.roster.heightUnits[v] }))}
                onChange={(v) => edit((s) => void (s.setup.config.playerFields.heightUnit = v))}
              />
            )}
          </Field>
        </div>
      </div>
    </>
  )
}
