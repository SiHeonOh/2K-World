import { useEffect, useRef, useState } from 'react'
import type { LoreConfig } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { ALWAYS_ASK, SUGGESTION_KINDS, type SuggestionMode } from '@shared/suggestions'
import { call } from '../../api'
import { Check, Field, Notice, Segmented, Select } from '../../components/ui'
import { useDraft } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'

const ts = t.suggest
const MODES: SuggestionMode[] = ['ask', 'auto', 'off']

/** The lore suggestion settings: the round sweep, ask/auto/off per kind (models: AiSettings). */
export function LoreSuggestSettings() {
  const { league, reload, refreshing } = useLeague()
  const [draft, edit, reset] = useDraft<LoreConfig>(() => structuredClone(league.config.lore))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const stored = JSON.stringify(league.config.lore)
  const dirty = JSON.stringify(draft) !== stored
  const busy = saving || refreshing

  // Once the reloaded league arrives after a save, the form takes what was stored.
  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(structuredClone(league.config.lore))
    setSaving(false)
  }, [league, refreshing, reset])

  const save = async () => {
    if (busy || !dirty) return
    setSaving(true)
    setSaved(null)
    setError(null)
    try {
      const r = await call('suggestions.saveSettings', league.slug, draft)
      setSaved(r.applied ? ts.applied(r.applied) : ts.saved)
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
        <h2>{ts.settingsTitle}</h2>
      </div>
      <p className="help">{ts.settingsHelp}</p>
      <Check checked={draft.roundSweep} onChange={(v) => edit((d) => void (d.roundSweep = v))}>
        {ts.roundSweep}
      </Check>
      <div className="topic-mix">
        {SUGGESTION_KINDS.map((k) => (
          <div key={k} className="topic-row">
            <div className="topic-name">
              <b>{ts.kinds[k]}</b>
              <span className="help">{ts.kindHelp[k]}</span>
            </div>
            <Segmented
              ariaLabel={ts.kinds[k]}
              value={draft.suggest[k] ?? 'ask'}
              // A secret reveal is never put in by itself: ask or off only.
              options={MODES.filter((m) => m !== 'auto' || !ALWAYS_ASK.includes(k)).map((m) => ({ value: m, label: ts.modes[m]! }))}
              onChange={(v) =>
                edit((d) => {
                  // Only what differs from asking is stored.
                  if (v === 'ask') delete d.suggest[k]
                  else d.suggest[k] = v
                })
              }
            />
          </div>
        ))}
      </div>
      {error ? <RuleErrors error={error} /> : null}
      {saved && !dirty && !busy ? <Notice tone="ok">{saved}</Notice> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {ts.save}
        </button>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => reset(structuredClone(league.config.lore))}>
          {ts.cancel}
        </button>
      </div>
    </div>
  )
}
