import { useState } from 'react'
import { defaultConfig } from '@shared/config/defaults'
import { suggestSlug } from '@shared/league'
import type { TemplateFile } from '@shared/template'
import { call } from '../../../api'
import { Badge, ErrorBox, Loading } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import type { Edit, StepProps, WizardState } from '../state'

function applyTemplate(edit: Edit, template: TemplateFile, id: string) {
  edit((s) => {
    s.source = { kind: 'template', id, name: template.meta.name }
    s.setup = { config: template.config, teams: template.teams ?? [], players: template.players ?? [] }
    s.baseTeams = template.teams
    s.workbook = null
    s.analysis = null
    s.mapping = null
    s.templateMapping = template.importMapping ?? null
    s.imported = null
    s.importedMapping = null
    // The settings already exist as a template; saving another copy is opt-in.
    s.saveTemplate = { enabled: false, name: template.meta.name, includePlayers: false }
    if (!s.slugTouched) s.slug = suggestSlug(template.config.league.name)
  })
}

/** Switching the starting point throws away imported players and edits; ask first. */
const okToReplace = (state: WizardState) =>
  (state.setup.players.length === 0 && !state.imported) || window.confirm(t.wizard.start.confirmSwitch)

export function StartStep({ state, edit, goTo }: StepProps & { goTo: (s: 'league') => void }) {
  const templates = useLoad(() => call('templates.list'), [])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const selected = (id: string) => state.source.kind === 'template' && state.source.id === id

  const pick = async (id: string) => {
    // Picking the current card again keeps the work done on it and just moves on.
    if (selected(id)) return goTo('league')
    if (!okToReplace(state)) return
    setBusy(true)
    setError(null)
    try {
      applyTemplate(edit, await call('templates.load', id), id)
      goTo('league')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const openFile = async () => {
    setError(null)
    try {
      const template = await call('templates.openFile', { title: t.wizard.start.openTitle, filterName: t.wizard.start.filter })
      if (template && okToReplace(state)) {
        applyTemplate(edit, template, `file:${template.meta.name}`)
        goTo('league')
      }
    } catch (e) {
      setError(e)
    }
  }

  const blank = () => {
    // Blank is preselected on a fresh wizard, so this is also the plain "start" click.
    if (state.source.kind === 'blank') return goTo('league')
    if (!okToReplace(state)) return
    edit((s) => {
      s.source = { kind: 'blank' }
      s.setup = { config: defaultConfig(), teams: [], players: [] }
      s.baseTeams = undefined
      s.workbook = null
      s.mapping = null
      s.templateMapping = null
      s.analysis = null
      s.imported = null
      s.importedMapping = null
      s.saveTemplate.enabled = true
    })
    goTo('league')
  }

  return (
    <div className="card">
      <h2>{t.wizard.steps.start}</h2>
      <p className="help">{t.wizard.start.intro}</p>
      {error ? <ErrorBox error={error} /> : null}
      <div className="grid-cards">
        <button className={`choice ${state.source.kind === 'blank' ? 'on' : ''}`} onClick={blank} disabled={busy}>
          <span className="title">{t.wizard.start.blank}</span>
          <span className="help">{t.wizard.start.blankHelp}</span>
        </button>
        {templates.state === 'ready'
          ? templates.value.map((tpl) => (
              <button
                key={tpl.id}
                className={`choice ${selected(tpl.id) ? 'on' : ''}`}
                disabled={busy || tpl.error !== undefined}
                onClick={() => void pick(tpl.id)}
              >
                <span className="title">{tpl.name}</span>
                {tpl.description ? <span className="help">{tpl.description}</span> : null}
                <span className="row" style={{ gap: 6 }}>
                  <Badge>{tpl.source === 'builtin' ? t.wizard.start.builtin : t.wizard.start.user}</Badge>
                  {tpl.hasTeams ? <Badge tone="info">{t.wizard.start.withTeams}</Badge> : null}
                  {tpl.hasPlayers ? <Badge tone="info">{t.wizard.start.withPlayers}</Badge> : null}
                  {tpl.error ? <Badge tone="err">{t.wizard.start.unusable}</Badge> : null}
                </span>
                {tpl.error ? <span className="help">{t.errors.template(tpl.error)}</span> : null}
              </button>
            ))
          : null}
      </div>
      {templates.state === 'loading' ? <Loading /> : null}
      {templates.state === 'error' ? <ErrorBox error={templates.error} onRetry={templates.reload} /> : null}
      <div>
        <button className="btn" onClick={() => void openFile()}>
          {t.wizard.start.openFile}
        </button>
      </div>
    </div>
  )
}
