import { useEffect, useRef, useState } from 'react'
import type { WikiConfig } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { Notice, Segmented } from '../../components/ui'
import { useDraft } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'

const tw = t.wiki
const MODES: WikiConfig['editWars'][] = ['off', 'sometimes', 'often']

/** The wiki's settings: how readily editors fight (models: AiSettings). */
export function WikiSettings() {
  const { league, reload, refreshing } = useLeague()
  const [draft, edit, reset] = useDraft<WikiConfig>(() => structuredClone(league.config.wiki))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(league.config.wiki)
  const busy = saving || refreshing

  // Once the reloaded league arrives after a save, the form takes what was stored.
  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(structuredClone(league.config.wiki))
    setSaving(false)
  }, [league, refreshing, reset])

  const save = async () => {
    if (busy || !dirty) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await call('wiki.saveSettings', league.slug, draft)
      setSaved(true)
      savedFrom.current = league
      reload()
    } catch (e) {
      setError(e)
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{tw.settingsTitle}</h2>
      </div>
      <p className="help">{tw.settingsHelp}</p>
      <div className="topic-row">
        <div className="topic-name">
          <b>{tw.editWars}</b>
          <span className="help">{tw.editWarHelp[draft.editWars]}</span>
        </div>
        <Segmented
          ariaLabel={tw.editWars}
          value={draft.editWars}
          options={MODES.map((m) => ({ value: m, label: tw.editWarModes[m]! }))}
          onChange={(v) => edit((d) => void (d.editWars = v))}
        />
      </div>
      {error ? <RuleErrors error={error} /> : null}
      {saved && !dirty && !busy ? <Notice tone="ok">{tw.savedSettings}</Notice> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {tw.saveSettings}
        </button>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => reset(structuredClone(league.config.wiki))}>
          {tw.undoSettings}
        </button>
      </div>
    </div>
  )
}
