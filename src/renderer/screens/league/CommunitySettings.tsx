import { useEffect, useRef, useState } from 'react'
import type { CommunityConfig } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { DEFAULT_TOPIC_MIX, TOPIC_KINDS } from '@shared/config/schema'
import { Check, Field, IssueList, Notice, NumberInput, Segmented, Select } from '../../components/ui'
import { useDraft } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'

const ts = t.community.settings
/** The schema's limits (communitySchema: myNick ≤ 20; board names are kept short for the tab bar, under nameSchema's 80). */
const NICK_MAX = 20
const BOARD_NAME_MAX = 40

/** What the server stores: names trimmed (the schema trims them anyway). */
function normalized(c: CommunityConfig): CommunityConfig {
  return { ...c, myNick: c.myNick.trim(), boards: c.boards.map((b) => ({ ...b, name: b.name.trim() })) }
}

/** A plain text box with a length limit (the shared TextInput has none). */
function LimitedInput({ id, value, max, invalid, width, onChange }: { id: string; value: string; max: number; invalid: boolean; width: number; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      id={id}
      className={invalid ? 'invalid' : ''}
      value={value}
      maxLength={max}
      aria-invalid={invalid || undefined}
      style={{ width }}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** The community's settings: boards (rename only), cast, thresholds, refresh, budget (models: AiSettings). */
export function CommunitySettings() {
  const { league, reload, refreshing } = useLeague()
  const [draft, edit, reset] = useDraft<CommunityConfig>(() => structuredClone(league.config.community))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // The snapshot a save started from: once a newer one has loaded, the draft takes the stored values.
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const stored = JSON.stringify(league.config.community)
  const clean = normalized(draft)
  // Stray spaces aren't a change: the server trims them, so comparing raw text would stay "dirty" forever.
  const dirty = JSON.stringify(clean) !== stored
  const edited = JSON.stringify(draft) !== stored
  const busy = saving || refreshing

  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(structuredClone(league.config.community))
    setSaving(false)
  }, [league, refreshing, reset])

  const problems = [
    ...(clean.myNick === '' ? [ts.noNick] : []),
    ...clean.boards.filter((b) => b.name === '').map((b) => ts.noBoardName(ts.roles[b.role] ?? b.role)),
  ]

  const save = async () => {
    if (busy || !dirty || problems.length > 0) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await call('community.saveSettings', league.slug, clean)
      setSaved(true)
      // Stay busy until the reloaded league arrives; the effect above then resets the draft to what was stored.
      savedFrom.current = league
      reload()
    } catch (e) {
      setError(e)
      setSaving(false)
    }
  }

  const num = (key: 'fans' | 'reporters' | 'maxSpice' | 'potenAt' | 'bestAt' | 'revealPerRefresh' | 'refillBelow' | 'chatterBatch' | 'dailyChatterJobs', min: number, max: number) => (
    <Field label={ts.fields[key]} help={ts.help[key]}>
      {/* Whole numbers only: the schema wants integers. */}
      {(id) => <NumberInput id={id} value={draft[key]} min={min} max={max} onChange={(v) => edit((d) => void (d[key] = Math.round(v)))} />}
    </Field>
  )

  return (
    <div className="card">
      <div className="card-head">
        <h2>{ts.title}</h2>
      </div>
      <p className="help">{ts.intro}</p>
      <div className="grid-2">
        <Check checked={draft.enabled} onChange={(v) => edit((d) => void (d.enabled = v))}>
          {ts.enabled}
        </Check>
        <Field label={ts.myNick}>
          {(id) => (
            <LimitedInput id={id} value={draft.myNick} max={NICK_MAX} invalid={clean.myNick === ''} width={200} onChange={(v) => edit((d) => void (d.myNick = v))} />
          )}
        </Field>
      </div>
      <h3>{ts.boards}</h3>
      <div className="grid-2">
        {draft.boards.map((b, i) => (
          <Field key={b.id} label={ts.roles[b.role] ?? b.role}>
            {(id) => (
              <LimitedInput
                id={id}
                value={b.name}
                max={BOARD_NAME_MAX}
                invalid={b.name.trim() === ''}
                width={220}
                onChange={(v) => edit((d) => void (d.boards[i]!.name = v))}
              />
            )}
          </Field>
        ))}
      </div>
      <h3>{ts.cast}</h3>
      <p className="help">{ts.castHelp}</p>
      <div className="grid-2">
        {num('fans', 0, 1000)}
        {num('reporters', 0, 20)}
        {num('maxSpice', 1, 5)}
      </div>
      <h3>{ts.feed}</h3>
      <div className="grid-2">
        {num('potenAt', 1, 100000)}
        {num('bestAt', 1, 100000)}
        {num('revealPerRefresh', 1, 20)}
        {num('refillBelow', 0, 200)}
        {num('chatterBatch', 5, 60)}
        {num('dailyChatterJobs', 0, 500)}
      </div>
      <h3>{ts.topics}</h3>
      <p className="help">{ts.topicsHelp}</p>
      <div className="topic-mix">
        {TOPIC_KINDS.map((k) => (
          <div key={k} className="topic-row">
            <div className="topic-name">
              <b>{ts.topicNames[k]}</b>
              <span className="help">{ts.topicHelp[k]}</span>
            </div>
            <Segmented
              ariaLabel={ts.topicNames[k]}
              value={draft.topicMix[k] ?? DEFAULT_TOPIC_MIX[k]}
              options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 0 ? ts.topicOff : String(n) }))}
              onChange={(v) =>
                edit((d) => {
                  // Only what differs from the default is stored.
                  if (v === DEFAULT_TOPIC_MIX[k]) delete d.topicMix[k]
                  else d.topicMix[k] = v
                })
              }
            />
          </div>
        ))}
      </div>
      {problems.length > 0 ? (
        <Notice tone="err">
          <IssueList items={problems.map((text) => ({ level: 'error' as const, text }))} />
        </Notice>
      ) : null}
      {error ? <RuleErrors error={error} /> : null}
      {saved && !edited && !busy ? <Notice tone="ok">{ts.saved}</Notice> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty || problems.length > 0} onClick={() => void save()}>
          {ts.save}
        </button>
        <button className="btn ghost" disabled={busy || !edited} onClick={() => reset(structuredClone(league.config.community))}>
          {ts.undo}
        </button>
      </div>
    </div>
  )
}
