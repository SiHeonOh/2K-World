import { useEffect, useRef, useState } from 'react'
import type { RecentJob } from '@shared/ai'
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

/** Any job finishing, done or failed, adds a row; the queue pausing (a job waiting to try again) too. */
const JOBS_TOPIC: PushTopic[] = ['jobs']

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

/** The latest finished jobs (and any waiting to try again): what each asked for, which model answered, and what it used. */
function RecentJobs({ slug }: { slug: string }) {
  const jobs = useLoad(() => call('ai.recentJobs', slug), [slug], { keepPrevious: true })
  usePush(slug, JOBS_TOPIC, jobs.reload)
  return (
    <div className="card ai-recent">
      <div className="card-head">
        <h2>{tr.title}</h2>
        <button className="btn small ghost" disabled={jobs.state === 'loading' || jobs.refreshing} onClick={jobs.reload}>
          {tr.reload}
        </button>
      </div>
      <p className="help">{tr.help}</p>
      {jobs.state === 'loading' ? (
        <Loading />
      ) : jobs.state === 'error' ? (
        <ErrorBox error={jobs.error} onRetry={jobs.reload} />
      ) : jobs.value.length === 0 ? (
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
              {jobs.value.map((j, _, all) => (
                <tr key={j.id} id={`ai-job-${j.id}`}>
                  <td>{j.job ? ta.jobs[j.job].name : j.kind}</td>
                  <td>{formatDate(j.finishedAt, true)}</td>
                  <td>
                    {j.status === 'done' ? (
                      <Badge tone="ok">{tr.done}</Badge>
                    ) : j.status === 'waiting' ? (
                      <Badge tone="warn">{j.errorKind ? `${tr.waiting} · ${tr.errors[j.errorKind]}` : tr.waiting}</Badge>
                    ) : (
                      <Badge tone="err">{j.errorKind ? `${tr.failed} · ${tr.errors[j.errorKind]}` : tr.failed}</Badge>
                    )}
                    {j.redoneBy !== null ? <Redo label={tr.redone} help={tr.redoneHelp} to={j.redoneBy} shown={new Set(all.map((x) => x.id))} jump={tr.toRedo} /> : null}
                    {j.numberRetry ? <Redo label={tr.redo} help={tr.redoHelp} to={j.retryOf} shown={new Set(all.map((x) => x.id))} jump={tr.toFirst} /> : null}
                    {j.retriedBy !== null && !j.canRetry ? (
                      <Redo label={tr.retried} help={tr.retriedHelp} to={j.retriedBy} shown={new Set(all.map((x) => x.id))} jump={tr.toRetry} />
                    ) : null}
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
    </div>
  )
}
