import { useEffect, useRef, useState } from 'react'
import type { LeagueConfig } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { Check, Field, Notice, NumberInput, Select } from '../../components/ui'
import { useDraft } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'

const tg = t.gm
const g = t.wizard.gm
type GmConfig = LeagueConfig['gm']

/** The AI GMs' settings: autonomy, window rhythm, how many GMs and talks a window holds, rumors, the log (models: AiSettings). */
export function GmSettings() {
  const { league, reload, refreshing } = useLeague()
  const [draft, edit, reset] = useDraft<GmConfig>(() => structuredClone(league.config.gm))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const stored = JSON.stringify(league.config.gm)
  const dirty = JSON.stringify(draft) !== stored
  const busy = saving || refreshing

  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(structuredClone(league.config.gm))
    setSaving(false)
  }, [league, refreshing, reset])

  const save = async () => {
    if (busy || !dirty) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await call('gm.saveSettings', league.slug, draft)
      setSaved(true)
      savedFrom.current = league
      reload()
    } catch (e) {
      setError(e)
      setSaving(false)
    }
  }

  const num = (key: 'tradeWindowEveryRounds' | 'gmsPerWindow' | 'talksPerWindow', label: string, help: string | undefined, min: number, max: number) => (
    <Field label={label} help={help}>
      {(id) => <NumberInput id={id} value={draft[key]} min={min} max={max} onChange={(v) => edit((d) => void (d[key] = Math.max(min, Math.min(max, Math.round(v)))))} />}
    </Field>
  )

  return (
    <div className="card">
      <div className="card-head">
        <h2>{tg.settingsTitle}</h2>
      </div>
      <p className="help">{tg.settingsHelp}</p>
      <div className="grid-2">
        <Field label={g.autonomy} help={g.autonomyHelp}>
          {(id) => (
            <Select
              id={id}
              value={draft.autonomy}
              options={(['full', 'auto-within-limits', 'propose'] as const).map((v) => ({ value: v, label: g.autonomies[v] }))}
              onChange={(v) => edit((d) => void (d.autonomy = v))}
            />
          )}
        </Field>
        {num('tradeWindowEveryRounds', g.windowEvery, undefined, 1, 100)}
        {num('gmsPerWindow', tg.gmsPerWindow, tg.gmsPerWindowHelp, 1, 40)}
        {num('talksPerWindow', tg.talksPerWindow, tg.talksPerWindowHelp, 1, 20)}
        <Field label={g.negotiationLog}>
          {(id) => (
            <Select
              id={id}
              value={draft.negotiationLog}
              options={(['live', 'after-window'] as const).map((v) => ({ value: v, label: g.negotiationLogs[v] }))}
              onChange={(v) => edit((d) => void (d.negotiationLog = v))}
            />
          )}
        </Field>
        <Field label="">
          <Check checked={draft.rumorLeaks} onChange={(v) => edit((d) => void (d.rumorLeaks = v))}>
            {g.rumorLeaks}
          </Check>
        </Field>
      </div>
      {error ? <RuleErrors error={error} /> : null}
      {saved && !dirty && !busy ? <Notice tone="ok">{tg.saved}</Notice> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {tg.save}
        </button>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => reset(structuredClone(league.config.gm))}>
          {tg.undo}
        </button>
      </div>
    </div>
  )
}
