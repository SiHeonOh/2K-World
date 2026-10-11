import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { FolderInspection } from '@shared/league'
import { isValidSlug } from '@shared/league'
import { validateSetup } from '@shared/setup'
import { call } from '../../api'
import { useDraft } from '../../hooks'
import { t } from '../../i18n'
import { initialState, STEP_SECTIONS, STEPS, type StepId, type StepProps } from './state'
import { AwardsStep } from './steps/AwardsStep'
import { GmStep } from './steps/GmStep'
import { ImportStep } from './steps/ImportStep'
import { LeagueStep } from './steps/LeagueStep'
import { ReviewStep } from './steps/ReviewStep'
import { RosterStep } from './steps/RosterStep'
import { RulesStep } from './steps/RulesStep'
import { SeasonStep } from './steps/SeasonStep'
import { StartStep } from './steps/StartStep'
import { StructureStep } from './steps/StructureStep'

const STEP_COMPONENTS: Record<StepId, (props: StepProps & { goTo: (s: StepId) => void }) => React.ReactNode> = {
  start: StartStep,
  league: LeagueStep,
  import: ImportStep,
  structure: StructureStep,
  roster: RosterStep,
  season: SeasonStep,
  awards: AwardsStep,
  rules: RulesStep,
  gm: GmStep,
  review: ReviewStep,
}

export function Wizard() {
  const [params] = useSearchParams()
  const [state, edit] = useDraft(() => initialState(params.get('slug') ?? ''))
  const [step, setStep] = useState<StepId>('start')
  const [folder, setFolder] = useState<FolderInspection | null>(null)

  // Live validation of the whole setup; cheap enough to run on every change.
  const issues = useMemo(() => validateSetup(state.setup), [state.setup])

  // Look at the target folder (existing league? lore folders?) as the name changes.
  useEffect(() => {
    if (!isValidSlug(state.slug)) {
      setFolder(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      call('leagues.inspect', state.slug).then(
        (f) => alive && setFolder(f),
        () => alive && setFolder(null),
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [state.slug])

  // The last inspection may be for a name typed earlier; only trust it for the current one.
  const currentFolder = folder && folder.slug === state.slug ? folder : null
  const index = STEPS.indexOf(step)
  const Step = STEP_COMPONENTS[step]
  const counts = (s: StepId) => {
    const sections = STEP_SECTIONS[s]
    const mine = issues.filter((i) => sections.includes(i.section))
    return { errors: mine.filter((i) => i.level === 'error').length, warnings: mine.filter((i) => i.level === 'warning').length }
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.wizard.title}</h1>
      </div>
      <div className="wizard">
        <nav className="stepper">
          {STEPS.map((s, i) => {
            const c = counts(s)
            return (
              <button key={s} className={s === step ? 'on' : ''} onClick={() => setStep(s)}>
                <span className="num">{i + 1}</span>
                <span>{t.wizard.steps[s]}</span>
                <span className="marks">
                  {c.errors > 0 ? <span className="mark err" title={t.wizard.errorsInStep(c.errors)} /> : null}
                  {c.warnings > 0 ? <span className="mark warn" title={t.wizard.warningsInStep(c.warnings)} /> : null}
                </span>
              </button>
            )
          })}
        </nav>
        <div className="wizard-body">
          <Step state={state} edit={edit} issues={issues} folder={currentFolder} goTo={setStep} />
          {step !== 'review' ? (
            <div className="wizard-nav">
              <button className="btn" disabled={index === 0} onClick={() => setStep(STEPS[index - 1]!)}>
                {t.app.back}
              </button>
              <button className="btn primary" onClick={() => setStep(STEPS[index + 1]!)}>
                {t.app.next}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
