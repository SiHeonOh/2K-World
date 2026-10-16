import type { AwardScope } from '@shared/awards'
import { Badge, NumberInput, RowControls, Select, TextInput, move } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { Edit, StepProps, WizardState } from '../state'

function newAwardId(s: WizardState): string {
  const taken = new Set([...s.setup.config.awards.season, ...s.setup.config.awards.periodic].map((a) => a.id))
  for (let n = 1; ; n++) if (!taken.has(`award-${n}`)) return `award-${n}`
}

/** `given`: awards already given (리그 설정): they can't be removed, and say so. */
interface CardProps {
  state: WizardState
  edit: Edit
  given?: ReadonlySet<string>
}

function GivenMark({ id, given }: { id: string; given?: ReadonlySet<string> }) {
  return given?.has(id) ? (
    <span title={t.leagueSettings.givenAward}>
      <Badge tone="info">✓</Badge>
    </span>
  ) : null
}

export function SeasonAwardsCard({ state, edit, given }: CardProps) {
  const { awards } = state.setup.config
  return (
    <div className="card flush">
      <div className="card-head" style={{ padding: '14px 16px' }}>
        <h2>{t.wizard.awards.season}</h2>
        <button
          className="btn small"
          onClick={() =>
            edit((s) =>
              void s.setup.config.awards.season.push({
                id: newAwardId(s),
                name: t.wizard.awards.newAward,
                kind: 'player',
                teams: 1,
                perTeam: 1,
                timing: 'regular-season',
              }),
            )
          }
        >
          {t.wizard.awards.addSeason}
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t.wizard.awards.name}</th>
              <th>{t.wizard.awards.kind}</th>
              <th>{t.wizard.awards.teams}</th>
              <th>{t.wizard.awards.perTeam}</th>
              <th>{t.wizard.awards.timing}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {awards.season.map((a, i) => (
              <tr key={a.id}>
                <td>
                  <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <TextInput
                      compact
                      ariaLabel={t.wizard.awards.name}
                      value={a.name}
                      width={240}
                      onChange={(v) => edit((s) => void (s.setup.config.awards.season[i]!.name = v))}
                    />
                    <GivenMark id={a.id} given={given} />
                  </span>
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.kind)}
                    value={a.kind}
                    options={(['player', 'selection'] as const).map((v) => ({ value: v, label: t.wizard.awards.kinds[v] }))}
                    onChange={(v) =>
                      edit((s) => {
                        const award = s.setup.config.awards.season[i]!
                        award.kind = v
                        if (v === 'player') {
                          award.teams = 1
                          award.perTeam = 1
                        } else if (award.perTeam === 1) {
                          award.teams = 3
                          award.perTeam = 5
                        }
                      })
                    }
                  />
                </td>
                <td>
                  {a.kind === 'selection' ? (
                    <NumberInput
                      compact
                      ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.teams)}
                      value={a.teams}
                      min={1}
                      max={10}
                      onChange={(v) => edit((s) => void (s.setup.config.awards.season[i]!.teams = Math.max(1, v)))}
                    />
                  ) : null}
                </td>
                <td>
                  {a.kind === 'selection' ? (
                    <NumberInput
                      compact
                      ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.perTeam)}
                      value={a.perTeam}
                      min={1}
                      max={15}
                      onChange={(v) => edit((s) => void (s.setup.config.awards.season[i]!.perTeam = Math.max(1, v)))}
                    />
                  ) : null}
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.timing)}
                    value={a.timing}
                    options={(['regular-season', 'finals'] as const).map((v) => ({ value: v, label: t.wizard.awards.timings[v] }))}
                    onChange={(v) => edit((s) => void (s.setup.config.awards.season[i]!.timing = v))}
                  />
                </td>
                <td>
                  <RowControls
                    index={i}
                    count={awards.season.length}
                    onMove={(from, to) => edit((s) => move(s.setup.config.awards.season, from, to))}
                    onRemove={given?.has(a.id) ? undefined : () => edit((s) => void s.setup.config.awards.season.splice(i, 1))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A new weekly or monthly award goes per conference once the league has two (as the NBA's do), else league-wide. */
const newScope = (s: WizardState): AwardScope => (s.setup.config.structure.conferences.length >= 2 ? 'conference' : 'league')

const SCOPES: AwardScope[] = ['league', 'conference', 'division']

export function PeriodicAwardsCard({ state, edit, given }: CardProps) {
  const { awards } = state.setup.config
  return (
    <div className="card flush">
      <div className="card-head" style={{ padding: '14px 16px' }}>
        <div>
          <h2>{t.wizard.awards.periodic}</h2>
          <p className="help">{t.wizard.awards.scopeHelp}</p>
        </div>
        <button
          className="btn small"
          onClick={() =>
            edit((s) => void s.setup.config.awards.periodic.push({ id: newAwardId(s), name: t.wizard.awards.newAward, period: 'week', winners: 1, scope: newScope(s) }))
          }
        >
          {t.wizard.awards.addPeriodic}
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t.wizard.awards.name}</th>
              <th>{t.wizard.awards.period}</th>
              <th>{t.wizard.awards.scope}</th>
              <th>{t.wizard.awards.winners}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {awards.periodic.map((a, i) => (
              <tr key={a.id}>
                <td>
                  <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <TextInput
                      compact
                      ariaLabel={t.wizard.awards.name}
                      value={a.name}
                      width={240}
                      onChange={(v) => edit((s) => void (s.setup.config.awards.periodic[i]!.name = v))}
                    />
                    <GivenMark id={a.id} given={given} />
                  </span>
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.period)}
                    value={a.period}
                    options={(['week', 'month'] as const).map((v) => ({ value: v, label: t.wizard.awards.periods[v] }))}
                    onChange={(v) => edit((s) => void (s.setup.config.awards.periodic[i]!.period = v))}
                  />
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.scope)}
                    value={a.scope}
                    options={SCOPES.map((v) => ({ value: v, label: t.wizard.awards.scopes[v] }))}
                    onChange={(v) => edit((s) => void (s.setup.config.awards.periodic[i]!.scope = v))}
                  />
                </td>
                <td>
                  <NumberInput
                    compact
                    ariaLabel={t.app.cellLabel(a.name, t.wizard.awards.winners)}
                    value={a.winners}
                    min={1}
                    max={10}
                    onChange={(v) => edit((s) => void (s.setup.config.awards.periodic[i]!.winners = Math.max(1, v)))}
                  />
                </td>
                <td>
                  <RowControls
                    index={i}
                    count={awards.periodic.length}
                    onMove={(from, to) => edit((s) => move(s.setup.config.awards.periodic, from, to))}
                    onRemove={given?.has(a.id) ? undefined : () => edit((s) => void s.setup.config.awards.periodic.splice(i, 1))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function AwardsStep({ state, edit, issues }: StepProps) {
  return (
    <>
      <SeasonAwardsCard state={state} edit={edit} />
      <PeriodicAwardsCard state={state} edit={edit} />
      <StepIssues issues={issues} sections={['awards']} />
    </>
  )
}
