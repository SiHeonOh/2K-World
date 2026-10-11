import { folderKey } from '@shared/setup'
import { Badge, RowControls, Select, TextInput, move } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { Edit, StepProps, WizardState } from '../state'

/** Picks a playoff format that fits the number of conferences. */
function fitPlayoffs(s: WizardState) {
  const { playoffs } = s.setup.config.season
  const n = s.setup.config.structure.conferences.length
  if (n === 0) {
    playoffs.bracket = 'league'
    playoffs.finals.kind = 'none'
  } else {
    playoffs.bracket = 'conference'
    playoffs.finals.kind = n === 2 ? 'conference-champions' : 'none'
  }
}

function newId(prefix: string, taken: string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`
}

/**
 * Conferences: add, rename, reorder, remove. `autoFit` keeps the playoff
 * format fitting the conference count (off in 리그 설정 when the playoff
 * format can't change now: the setup check says what no longer fits instead).
 */
export function ConferencesCard({ state, edit, autoFit = true }: { state: WizardState; edit: Edit; autoFit?: boolean }) {
  const { config, teams } = state.setup
  const { conferences, divisions } = config.structure
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t.wizard.structure.conferences}</h2>
        <button
          className="btn small"
          onClick={() =>
            edit((s) => {
              const list = s.setup.config.structure.conferences
              list.push({ id: newId('c', list.map((c) => c.id)), name: t.wizard.structure.newConference(list.length + 1) })
              if (autoFit) fitPlayoffs(s)
            })
          }
        >
          {t.wizard.structure.addConference}
        </button>
      </div>
      <p className="help">{t.wizard.structure.conferencesHelp}</p>
      <div className="list-editor">
        {conferences.map((c, i) => (
          <div key={c.id} className="item">
            <TextInput
              ariaLabel={t.wizard.structure.conference}
              value={c.name}
              onChange={(v) => edit((s) => void (s.setup.config.structure.conferences[i]!.name = v))}
            />
            <span className="muted">
              {t.wizard.structure.teamsIn(teams.filter((tm) => divisions.find((d) => d.id === tm.divisionId)?.conferenceId === c.id).length)}
            </span>
            <RowControls
              index={i}
              count={conferences.length}
              onMove={(from, to) => edit((s) => move(s.setup.config.structure.conferences, from, to))}
              onRemove={() =>
                edit((s) => {
                  const st = s.setup.config.structure
                  st.conferences.splice(i, 1)
                  for (const d of st.divisions) if (d.conferenceId === c.id) d.conferenceId = null
                  if (autoFit) fitPlayoffs(s)
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Divisions: add, rename, assign a conference, reorder; an empty one can go (a league keeps at least one). */
export function DivisionsCard({ state, edit }: { state: WizardState; edit: Edit }) {
  const { config, teams } = state.setup
  const { conferences, divisions } = config.structure
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t.wizard.structure.divisions}</h2>
        <button
          className="btn small"
          onClick={() =>
            edit((s) => {
              const list = s.setup.config.structure.divisions
              list.push({ id: newId('d', list.map((d) => d.id)), name: t.wizard.structure.newDivision(list.length + 1), conferenceId: null })
            })
          }
        >
          {t.wizard.structure.addDivision}
        </button>
      </div>
      <div className="list-editor">
        {divisions.map((d, i) => {
          const members = teams.filter((tm) => tm.divisionId === d.id).length
          return (
            <div key={d.id} className="item">
              <TextInput
                ariaLabel={t.wizard.structure.division}
                value={d.name}
                onChange={(v) => edit((s) => void (s.setup.config.structure.divisions[i]!.name = v))}
              />
              <Select
                ariaLabel={t.app.cellLabel(d.name, t.wizard.structure.conference)}
                value={d.conferenceId ?? ''}
                options={[{ value: '', label: t.wizard.structure.noConference }, ...conferences.map((c) => ({ value: c.id, label: c.name }))]}
                onChange={(v) => edit((s) => void (s.setup.config.structure.divisions[i]!.conferenceId = v === '' ? null : v))}
              />
              <span className="muted">{t.wizard.structure.teamsIn(members)}</span>
              <RowControls
                index={i}
                count={divisions.length}
                onMove={(from, to) => edit((s) => move(s.setup.config.structure.divisions, from, to))}
                onRemove={members === 0 && divisions.length > 1 ? () => edit((s) => void s.setup.config.structure.divisions.splice(i, 1)) : undefined}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function StructureStep({ state, edit, issues, folder }: StepProps) {
  const { config, teams } = state.setup
  const { divisions } = config.structure
  const lore = new Set((folder?.loreTeams ?? []).map(folderKey))
  const loreFound = teams.filter((tm) => lore.has(folderKey(tm.shortName))).length

  return (
    <>
      <ConferencesCard state={state} edit={edit} />
      <DivisionsCard state={state} edit={edit} />

      {teams.length > 0 ? (
        <div className="card flush">
          <div className="card-head" style={{ padding: '14px 16px' }}>
            <div>
              <h2>{t.wizard.structure.teams}</h2>
              <p className="help">{t.wizard.structure.shortNameHelp}</p>
            </div>
            {folder && folder.loreTeams.length > 0 ? (
              <Badge tone={loreFound === teams.length ? 'ok' : 'warn'}>{t.wizard.structure.loreSummary(loreFound, teams.length)}</Badge>
            ) : null}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.wizard.structure.fullName}</th>
                  <th>{t.wizard.structure.shortName}</th>
                  <th>{t.wizard.structure.division}</th>
                  {folder && folder.loreTeams.length > 0 ? <th>{t.wizard.structure.lore}</th> : null}
                </tr>
              </thead>
              <tbody>
                {teams.map((tm, i) => (
                  <tr key={tm.id}>
                    <td>{tm.name}</td>
                    <td>
                      <TextInput
                        compact
                        ariaLabel={t.app.cellLabel(tm.name, t.wizard.structure.shortName)}
                        value={tm.shortName}
                        onChange={(v) => edit((s) => void (s.setup.teams[i]!.shortName = v))}
                      />
                    </td>
                    <td>
                      <Select
                        compact
                        ariaLabel={t.app.cellLabel(tm.name, t.wizard.structure.division)}
                        value={tm.divisionId}
                        options={divisions.map((d) => ({ value: d.id, label: d.name }))}
                        onChange={(v) => edit((s) => void (s.setup.teams[i]!.divisionId = v))}
                      />
                    </td>
                    {folder && folder.loreTeams.length > 0 ? (
                      <td>
                        {lore.has(folderKey(tm.shortName)) ? (
                          <Badge tone="ok">{t.wizard.structure.loreFound}</Badge>
                        ) : (
                          <Badge tone="warn">{t.wizard.structure.loreMissing}</Badge>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <StepIssues issues={issues} sections={['structure', 'teams']} />
    </>
  )
}
