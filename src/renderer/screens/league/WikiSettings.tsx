import { useEffect, useRef, useState } from 'react'
import type { PushTopic } from '@shared/api'
import type { WikiConfig } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { ErrorBox, Notice, Segmented } from '../../components/ui'
import { useDraft, useLoad, usePush } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'

const tw = t.wiki
const tp = t.wiki.playerPages
const MODES: WikiConfig['editWars'][] = ['off', 'sometimes', 'often']
/** Jobs queued, started or cancelled anywhere (and finished ones): the waiting count follows them. */
const JOB_TOPICS: PushTopic[] = ['waiting', 'jobs']

/** The wiki's settings: how readily editors fight (models: AiSettings), and 선수 문서 다듬기. */
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
      <PlayerPages />
    </div>
  )
}

/**
 * 선수 문서 다듬기: the pages still showing the app's own 플레이 스타일 go to
 * the AI editors, about six of a school a job, after asking (how many jobs,
 * on which AI 모델 setting). Waiting ones can be cancelled here, or one by one
 * in 최근 작업.
 */
function PlayerPages() {
  const { league } = useLeague()
  const status = useLoad(() => call('wiki.playerPagesStatus', league.slug), [league.slug], { keepPrevious: true })
  usePush(league.slug, JOB_TOPICS, status.reload)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const ai = league.config.ai.jobs.wikiPlayer
  const model = `${t.aiModels.models[ai.model]} · ${t.aiModels.efforts[ai.effort]}`

  const act = async (fn: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setMessage(await fn())
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      status.reload()
    }
  }
  const polish = () =>
    act(async () => {
      const plan = await call('wiki.playerPagesPlan', league.slug)
      if (plan.jobs === 0) return tp.nothing
      if (!window.confirm(tp.confirm(plan.players, plan.jobs, model))) return null
      const r = await call('wiki.polishPlayerPages', league.slug)
      return r.jobs === 0 ? tp.nothing : tp.queued(r.players, r.jobs)
    })
  const cancel = (waiting: number) => {
    if (!window.confirm(tp.confirmCancel(waiting))) return
    void act(async () => tp.cancelled((await call('ai.cancelWaiting', league.slug, 'wiki_player')).cancelled))
  }
  const s = status.state === 'ready' ? status.value : null

  return (
    <div className="topic-row wk-polish">
      <div className="topic-name">
        <b>{tp.title}</b>
        <span className="help">{tp.help}</span>
        {s && s.waiting + s.running > 0 ? (
          <span className="row muted">
            <span className="spin" /> {tp.waiting(s.waiting, s.running)}
            {s.waiting > 0 ? (
              <button className="btn small ghost" disabled={busy} onClick={() => cancel(s.waiting)}>
                {tp.cancel}
              </button>
            ) : null}
          </span>
        ) : null}
        {message ? <Notice tone="ok">{message}</Notice> : null}
        {error ? <ErrorBox error={error} /> : null}
      </div>
      <button className="btn" disabled={busy} onClick={() => void polish()}>
        {busy ? tp.counting : tp.start}
      </button>
    </div>
  )
}
