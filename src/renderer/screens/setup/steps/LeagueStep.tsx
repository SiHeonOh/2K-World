import { followLeagueName } from '@shared/config/defaults'
import { isValidSlug, suggestSlug } from '@shared/league'
import { call } from '../../../api'
import { Field, Notice, TextInput } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { StepProps } from '../state'

export function LeagueStep({ state, edit, issues, folder }: StepProps) {
  const { config } = state.setup
  const leagues = useLoad(() => call('leagues.list'), [])
  const loreOnly = leagues.state === 'ready' ? leagues.value.filter((l) => !l.hasDb) : []
  const slugOk = isValidSlug(state.slug)

  return (
    <>
      <div className="card">
        <h2>{t.wizard.steps.league}</h2>
        <div className="grid-2">
          <Field label={t.wizard.league.name}>
            {(id) => (
              <TextInput
                id={id}
                value={config.league.name}
                placeholder={t.wizard.league.namePlaceholder}
                onChange={(v) =>
                  edit((s) => {
                    const before = { ...s.setup.config.league }
                    s.setup.config.league.name = v
                    followLeagueName(s.setup.config, before)
                    if (!s.slugTouched) s.slug = suggestSlug(v)
                    if (!s.saveTemplate.name || s.source.kind === 'blank') s.saveTemplate.name = v
                  })
                }
              />
            )}
          </Field>
          <Field label={t.wizard.league.shortName} help={t.wizard.league.shortNameHelp}>
            {(id) => (
              <TextInput
                id={id}
                value={config.league.shortName}
                onChange={(v) =>
                  edit((s) => {
                    const before = { ...s.setup.config.league }
                    s.setup.config.league.shortName = v
                    followLeagueName(s.setup.config, before)
                  })
                }
              />
            )}
          </Field>
          <Field label={t.wizard.league.season}>
            {(id) => (
              <TextInput id={id} value={config.season.label} onChange={(v) => edit((s) => void (s.setup.config.season.label = v))} />
            )}
          </Field>
        </div>
      </div>

      <div className="card">
        <Field label={t.wizard.league.slug} help={t.wizard.league.slugHelp}>
          {(id) => (
            <TextInput
              id={id}
              value={state.slug}
              invalid={state.slug !== '' && !slugOk}
              onChange={(v) =>
                edit((s) => {
                  s.slug = v.trim()
                  s.slugTouched = true
                })
              }
            />
          )}
        </Field>
        {loreOnly.length > 0 ? (
          <div className="row">
            <span className="muted">{t.wizard.league.existingFolders}</span>
            {loreOnly.map((l) => (
              <button
                key={l.slug}
                className="btn small"
                onClick={() =>
                  edit((s) => {
                    s.slug = l.slug
                    s.slugTouched = true
                  })
                }
              >
                {l.slug}
              </button>
            ))}
          </div>
        ) : null}
        {state.slug !== '' && !slugOk ? <Notice tone="err">{t.wizard.league.slugBad}</Notice> : null}
        {slugOk && folder ? (
          folder.hasDb ? (
            <Notice tone="err">{t.wizard.league.slugTaken}</Notice>
          ) : folder.exists ? (
            <Notice tone="info">
              {folder.loreTeams.length > 0 ? t.wizard.league.slugLore(folder.loreTeams.length) : t.wizard.league.slugExists}
            </Notice>
          ) : (
            <Notice tone="ok">{t.wizard.league.slugNew}</Notice>
          )
        ) : null}
      </div>
      <StepIssues issues={issues} sections={['league']} />
    </>
  )
}
