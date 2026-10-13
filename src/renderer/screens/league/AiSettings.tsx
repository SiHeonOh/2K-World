import { useEffect, useRef, useState } from 'react'
import { IN_QUEUE_SHOWN, type RecentJob } from '@shared/ai'
import type { PushTopic } from '@shared/api'
import { AI_JOBS, type AiConfig, type AiJob, type EffortSetting, type ModelName } from '@shared/config/schema'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { Badge, ErrorBox, Loading, Notice, Select } from '../../components/ui'
import { useDraft, useLoad, usePush } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { formatDate } from './util'

const ta = t.aiModels
const tr = ta.recent
const MODELS: ModelName[] = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS: EffortSetting[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
/** The jobs by where they show up, in the order a user meets them. */
const GROUPS: { title: string; jobs: AiJob[] }[] = [
  { title: ta.groups.community, jobs: ['gameThread', 'article', 'chatter', 'reply', 'live'] },
  { title: ta.groups.world, jobs: ['wiki', 'wikiTalk', 'wikiWar', 'player', 'loreDraft', 'loreSweep'] },
  { title: ta.groups.gm, jobs: ['gmIntent', 'gmRespond', 'gmDraft'] },
  { title: ta.groups.gameday, jobs: ['screenshot'] },
]

/** 편집실 → AI 모델: every job's model and effort, then what recent jobs really ran on. */
export function AiSettings() {
  const { league } = useLeague()
  return (
    <>
      <AiModels />
      <RecentJobs slug={league.slug} />
    </>
  )
}

/** Every AI job's model and effort, in one table. */
function AiModels() {
  const { league, reload, refreshing } = useLeague()
  const [draft, edit, reset] = useDraft<AiConfig>(() => structuredClone(league.config.ai))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [allModel, setAllModel] = useState<ModelName | ''>('')
  const [allEffort, setAllEffort] = useState<EffortSetting | ''>('')
  const savedFrom = useRef<LeagueSnapshot | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(league.config.ai)
  const busy = saving || refreshing

  useEffect(() => {
    if (savedFrom.current === null || refreshing || league === savedFrom.current) return
    savedFrom.current = null
    reset(structuredClone(league.config.ai))
    setSaving(false)
  }, [league, refreshing, reset])

  const save = async () => {
    if (busy || !dirty) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await call('ai.saveJobs', league.slug, draft)
      setSaved(true)
      savedFrom.current = league
      reload()
    } catch (e) {
      setError(e)
      setSaving(false)
    }
  }

  // Every job on one model or one effort at once.
  const setAll = (patch: { model?: ModelName; effort?: EffortSetting }) =>
    edit((d) => {
      for (const j of AI_JOBS) d.jobs[j] = { ...d.jobs[j], ...patch }
    })

  return (
    <div className="card ai-models">
      <div className="card-head">
        <h2>{ta.title}</h2>
      </div>
      <p className="help">{ta.help}</p>
      <div className="row ai-models-all">
        <span className="muted">{ta.all}</span>
        <Select<ModelName | ''>
          compact
          ariaLabel={ta.allModel}
          value={allModel}
          options={[{ value: '', label: `${ta.allModel}: ${ta.keep}` }, ...MODELS.map((m) => ({ value: m, label: ta.models[m] }))]}
          onChange={setAllModel}
        />
        <Select<EffortSetting | ''>
          compact
          ariaLabel={ta.allEffort}
          value={allEffort}
          options={[{ value: '', label: `${ta.allEffort}: ${ta.keep}` }, ...EFFORTS.map((e) => ({ value: e, label: ta.efforts[e] }))]}
          onChange={setAllEffort}
        />
        <button
          className="btn small"
          disabled={busy || (!allModel && !allEffort)}
          onClick={() => {
            setAll({ ...(allModel ? { model: allModel } : {}), ...(allEffort ? { effort: allEffort } : {}) })
            setAllModel('')
            setAllEffort('')
          }}
        >
          {ta.apply}
        </button>
      </div>
      <table className="table ai-models-table">
        <thead>
          <tr>
            <th>{ta.job}</th>
            <th>{ta.model}</th>
            <th>{ta.effort}</th>
          </tr>
        </thead>
        {GROUPS.map((g) => (
          <tbody key={g.title}>
            <tr className="ai-models-group">
              <th colSpan={3}>{g.title}</th>
            </tr>
            {g.jobs.map((j) => (
              <tr key={j}>
                <td>
                  <b>{ta.jobs[j].name}</b>
                  <div className="muted small">{ta.jobs[j].help}</div>
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={`${ta.jobs[j].name} ${ta.model}`}
                    value={draft.jobs[j].model}
                    options={MODELS.map((m) => ({ value: m, label: ta.models[m] }))}
                    onChange={(v) => edit((d) => void (d.jobs[j].model = v))}
                  />
                </td>
                <td>
                  <Select
                    compact
                    ariaLabel={`${ta.jobs[j].name} ${ta.effort}`}
                    value={draft.jobs[j].effort}
                    options={EFFORTS.map((e) => ({ value: e, label: ta.efforts[e] }))}
                    onChange={(v) => edit((d) => void (d.jobs[j].effort = v))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <p className="muted small">{ta.note}</p>
      {error ? <RuleErrors error={error} /> : null}
      {saved && !dirty && !busy ? <Notice tone="ok">{ta.saved}</Notice> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {ta.save}
        </button>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => reset(structuredClone(league.config.ai))}>
          {ta.undo}
        </button>
      </div>
    </div>
  )
}

/**
 * Any job finishing, done or failed, adds a row; the queue pausing (a job waiting to try again) too.
 * A job queued, started, put back or cancelled changes 대기 중.
 */
const JOBS_TOPIC: PushTopic[] = ['jobs', 'waiting']
const IN_QUEUE = new Set<RecentJob['status']>(['running', 'queued', 'waiting'])

const effortLabel = (effort: string) => (Object.hasOwn(ta.efforts, effort) ? ta.efforts[effort as EffortSetting] : effort)

function took(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? tr.seconds(s) : tr.minutes(Math.floor(s / 60), s % 60)
}

/** "sonnet · 높음 → claude-sonnet-…": the alias asked for and the exact model that answered. */
function ModelCell({ job }: { job: RecentJob }) {
  const unknown = <span className="muted">{tr.unknown}</span>
  if (!job.askedModel && !job.model) return <span className="muted">—</span>
  return (
    <>
      {job.askedModel ? `${job.askedModel}${job.askedEffort ? ` · ${effortLabel(job.askedEffort)}` : ''}` : unknown} → {job.model ?? unknown}
    </>
  )
}

/** A job the number check redid, or its redo: a badge, and a jump to the other one when it's in the list. */
function Redo({ label, help, to, shown, jump }: { label: string; help: string; to: number | null; shown: ReadonlySet<number>; jump: string }) {
  return (
    <span className="ai-redo" title={help}>
      <Badge tone="info">{label}</Badge>
      {to !== null && shown.has(to) ? (
        <button className="btn small ghost" onClick={() => document.getElementById(`ai-job-${to}`)?.scrollIntoView({ block: 'center' })}>
          {jump}
        </button>
      ) : null}
    </span>
  )
}

/**
 * Why a job failed or waits: its kind in a sentence, what happens next, and
 * Claude Code's own words, read only when opened (they can quote league lore).
 */
function JobDetails({ slug, job }: { slug: string; job: RecentJob }) {
  const [raw, setRaw] = useState<{ text: string | null } | { error: unknown } | null>(null)
  const kind = job.errorKind
  // Waiting: what the queue does next. Failed for good: what you can do.
  const fix = kind === null ? '' : job.status === 'waiting' ? (t.ai.fixes[kind] ?? '') : (tr.failedFixes[kind] ?? tr.failedFix)
  const load = (open: boolean) => {
    if (!open) return
    call('ai.jobError', slug, job.id).then(
      (r) => setRaw({ text: r.error }),
      (e: unknown) => setRaw({ error: e }),
    )
  }
  return (
    <details className="ai-job-details" onToggle={(e) => load(e.currentTarget.open)}>
      <summary>{tr.details}</summary>
      {kind ? (
        <p>
          {t.ai.reasons[kind] ?? kind}. {fix}
        </p>
      ) : null}
      {raw === null ? null : 'error' in raw ? (
        <ErrorBox error={raw.error} />
      ) : raw.text ? (
        <>
          <div className="muted small">{tr.raw}</div>
          <pre className="raw-error">{raw.text}</pre>
        </>
      ) : (
        <p className="muted small">{tr.noRaw}</p>
      )}
    </details>
  )
}

/** 다시 시도: the failed job's input queued again as a new job; the list looks again so the row says it was retried. */
function RetryButton({ slug, job, onRetried }: { slug: string; job: RecentJob; onRetried: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (done) return <Badge tone="info">{tr.retried}</Badge>
  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('ai.retryJob', slug, job.id)
      setDone(true)
      onRetried()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="btn small" disabled={busy} onClick={() => void retry()}>
        {busy ? tr.retrying : tr.retry}
      </button>
      {error ? <RuleErrors error={error} /> : null}
    </>
  )
}

const jobName = (j: RecentJob) => (j.job ? ta.jobs[j.job].name : j.kind)

/** 취소 for one job in the queue; a running one asks first (its run is ended and what it wrote dropped). */
function CancelButton({ slug, job, onCancelled }: { slug: string; job: RecentJob; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const cancel = async () => {
    if (job.status === 'running' && !window.confirm(tr.confirmCancelRunning(jobName(job)))) return
    setBusy(true)
    setError(null)
    try {
      await call('ai.cancelJob', slug, job.id)
      onCancelled()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="btn small ghost" title={tr.cancelHelp} disabled={busy} onClick={() => void cancel()}>
        {busy ? tr.cancelling : tr.cancel}
      </button>
      {error ? <RuleErrors error={error} /> : null}
    </>
  )
}

/**
 * 대기 중: the jobs still in the queue, the running one first, then the rest
 * in the order they'd run, each with 취소. A kind with several waiting gets
 * 모두 취소 (the running one finishes); `onNotice` says how many went, above
 * the list (which may be gone by then).
 */
function InQueue({
  slug,
  jobs,
  shown,
  onChange,
  onNotice,
}: {
  slug: string
  jobs: RecentJob[]
  shown: ReadonlySet<number>
  onChange: () => void
  onNotice: (text: string | null) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const running = jobs.some((j) => j.status === 'running')
  // A running job's time keeps counting.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  const kinds = new Map<string, RecentJob[]>()
  for (const j of jobs) if (j.status !== 'running') kinds.set(j.kind, [...(kinds.get(j.kind) ?? []), j])
  const cancelAll = async (kind: string, first: RecentJob, n: number) => {
    if (!window.confirm(tr.confirmCancelAll(jobName(first), n))) return
    setBusy(true)
    onNotice(null)
    setError(null)
    try {
      onNotice(tr.cancelledAll((await call('ai.cancelWaiting', slug, kind)).cancelled))
      onChange()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h3>{tr.inQueue(jobs.length)}</h3>
      {[...kinds].some(([, list]) => list.length > 1) ? (
        <div className="row">
          {[...kinds]
            .filter(([, list]) => list.length > 1)
            .map(([kind, list]) => (
              <button key={kind} className="btn small ghost" disabled={busy} onClick={() => void cancelAll(kind, list[0]!, list.length)}>
                {tr.cancelAll(jobName(list[0]!), list.length)}
              </button>
            ))}
        </div>
      ) : null}
      {error ? <RuleErrors error={error} /> : null}
      <div className="table-wrap">
        <table className="data compact ai-in-queue">
          <thead>
            <tr>
              <th>{tr.job}</th>
              <th>{tr.queuedAt}</th>
              <th>{tr.status}</th>
              <th>{ta.model}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} id={`ai-job-${j.id}`}>
                <td>{jobName(j)}</td>
                <td>{formatDate(j.queuedAt, true)}</td>
                <td>
                  {j.status === 'running' ? (
                    <Badge tone="info">{j.startedAt ? tr.runningFor(took(Math.max(0, now - Date.parse(j.startedAt)))) : tr.running}</Badge>
                  ) : j.status === 'waiting' ? (
                    <Badge tone="warn">{j.errorKind ? `${tr.waiting} · ${tr.errors[j.errorKind]}` : tr.waiting}</Badge>
                  ) : (
                    <Badge>{tr.queued}</Badge>
                  )}
                  {j.numberRetry ? <Redo label={tr.redo} help={tr.redoHelp} to={j.retryOf} shown={shown} jump={tr.toFirst} /> : null}
                  {j.status === 'waiting' ? (
                    <div className="ai-job-actions">
                      <JobDetails slug={slug} job={j} />
                    </div>
                  ) : null}
                </td>
                <td>{j.askedModel ? `${j.askedModel}${j.askedEffort ? ` · ${effortLabel(j.askedEffort)}` : ''}` : <span className="muted">—</span>}</td>
                <td>
                  <CancelButton slug={slug} job={j} onCancelled={onChange} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {jobs.length >= IN_QUEUE_SHOWN ? <p className="muted small">{tr.moreInQueue(IN_QUEUE_SHOWN)}</p> : null}
    </>
  )
}

/** The jobs still in the queue (대기 중), then the latest finished ones: what each asked for, which model answered, and what it used. */
function RecentJobs({ slug }: { slug: string }) {
  const jobs = useLoad(() => call('ai.recentJobs', slug), [slug], { keepPrevious: true })
  usePush(slug, JOBS_TOPIC, jobs.reload)
  const [notice, setNotice] = useState<string | null>(null)
  const all = jobs.state === 'ready' ? jobs.value : []
  const inQueue = all.filter((j) => IN_QUEUE.has(j.status))
  const finished = all.filter((j) => !IN_QUEUE.has(j.status))
  // Jumps between a number-check redo and the job it redoes work across both tables.
  const shown = new Set(all.map((x) => x.id))
  return (
    <div className="card ai-recent">
      <div className="card-head">
        <h2>{tr.title}</h2>
        <button className="btn small ghost" disabled={jobs.state === 'loading' || jobs.refreshing} onClick={jobs.reload}>
          {tr.reload}
        </button>
      </div>
      <p className="help">{tr.help}</p>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {jobs.state === 'loading' ? (
        <Loading />
      ) : jobs.state === 'error' ? (
        <ErrorBox error={jobs.error} onRetry={jobs.reload} />
      ) : (
        <>
          {inQueue.length > 0 ? <InQueue slug={slug} jobs={inQueue} shown={shown} onChange={jobs.reload} onNotice={setNotice} /> : null}
          {inQueue.length > 0 ? <h3>{tr.finished}</h3> : null}
          {finished.length === 0 ? (
            <p className="muted">{tr.empty}</p>
          ) : (
            <div className="table-wrap">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>{tr.job}</th>
                    <th>{tr.when}</th>
                    <th>{tr.status}</th>
                    <th>{tr.model}</th>
                    <th className="num">{tr.tokens}</th>
                    <th className="num">{tr.cost}</th>
                    <th className="num">{tr.took}</th>
                  </tr>
                </thead>
                <tbody>
                  {finished.map((j) => (
                    <tr key={j.id} id={`ai-job-${j.id}`}>
                      <td>{jobName(j)}</td>
                      <td>{formatDate(j.finishedAt, true)}</td>
                      <td>
                        {j.status === 'done' ? (
                          <Badge tone="ok">{tr.done}</Badge>
                        ) : (
                          <Badge tone="err">{j.errorKind ? `${tr.failed} · ${tr.errors[j.errorKind]}` : tr.failed}</Badge>
                        )}
                        {j.redoneBy !== null ? <Redo label={tr.redone} help={tr.redoneHelp} to={j.redoneBy} shown={shown} jump={tr.toRedo} /> : null}
                        {j.numberRetry ? <Redo label={tr.redo} help={tr.redoHelp} to={j.retryOf} shown={shown} jump={tr.toFirst} /> : null}
                        {j.retriedBy !== null && !j.canRetry ? <Redo label={tr.retried} help={tr.retriedHelp} to={j.retriedBy} shown={shown} jump={tr.toRetry} /> : null}
                        {j.status !== 'done' ? (
                          <div className="ai-job-actions">
                            {j.canRetry ? <RetryButton slug={slug} job={j} onRetried={jobs.reload} /> : null}
                            <JobDetails slug={slug} job={j} />
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <ModelCell job={j} />
                      </td>
                      {/* Input counts the cached part too; the tooltip splits it. */}
                      <td className="num" title={j.tokens ? tr.tokensDetail(j.tokens.input, j.tokens.cacheRead, j.tokens.cacheWrite, j.tokens.output) : undefined}>
                        {j.tokens ? tr.tokensLine(j.tokens.input + j.tokens.cacheRead + j.tokens.cacheWrite, j.tokens.output) : '—'}
                      </td>
                      <td className="num">{j.costUsd === null ? '—' : `$${j.costUsd.toFixed(3)}`}</td>
                      <td className="num">{j.durationMs === null ? '—' : took(j.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
