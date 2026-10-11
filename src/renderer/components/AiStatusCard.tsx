import { useState } from 'react'
import type { AiStatus, QueueState } from '@shared/ai'
import type { JobInfo } from '@shared/gameday'
import { call } from '../api'
import { t } from '../i18n'
import { Badge, ErrorBox, Notice } from './ui'

const INSTALL_URL = 'https://code.claude.com/docs/en/setup'

/** Why the queue is paused and until when: a usage limit, or a problem that should pass (offline, Claude busy…). */
function pauseText(queue: QueueState): string {
  const until = new Date(queue.pausedUntil ?? '').toLocaleString()
  if (!queue.pauseReason || queue.pauseReason === 'limit') return t.ai.paused(until)
  return t.ai.pausedFor(t.ai.reasons[queue.pauseReason] ?? queue.pauseReason, until)
}

/** The 다시 확인 button: looks for Claude Code again (which also lets a blocked queue try again). */
function useRecheck(onChange: (s: AiStatus) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const recheck = async () => {
    setBusy(true)
    setError(null)
    try {
      onChange(await call('ai.recheck'))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, recheck }
}

/** Claude Code on this PC: installed, signed in, and billing safely. */
export function AiStatusCard({ status, onChange }: { status: AiStatus; onChange: (s: AiStatus) => void }) {
  const { busy, error, recheck } = useRecheck(onChange)
  const { claude } = status
  const ready = claude.installed && claude.loggedIn && !status.billing

  return (
    <div className="card">
      <div className="card-head">
        <h2>{t.ai.title}</h2>
        <div className="row" style={{ gap: 6 }}>
          {ready ? <Badge tone="ok">{t.ai.ready}</Badge> : null}
          <button className="btn small" disabled={busy} onClick={() => void recheck()}>
            {t.ai.recheck}
          </button>
        </div>
      </div>
      <p className="help">{t.ai.help}</p>
      {status.fake ? <Notice tone="info">{t.ai.demo}</Notice> : null}
      <div className="row" style={{ gap: 6 }}>
        <Badge tone={claude.installed ? 'ok' : 'err'}>{claude.installed ? t.ai.installed : t.ai.notInstalled}</Badge>
        {claude.version ? <Badge>{t.ai.version(claude.version)}</Badge> : null}
        {claude.installed ? <Badge tone={claude.loggedIn ? 'ok' : 'warn'}>{claude.loggedIn ? t.ai.signedIn : t.ai.signedOut}</Badge> : null}
        {claude.authMethod ? (
          <Badge tone={status.billing ? 'err' : undefined}>
            {t.ai.method(claude.authMethod === 'claude.ai' ? t.ai.subscription : claude.authMethod)}
          </Badge>
        ) : null}
      </div>
      {!claude.installed ? (
        <Notice tone="warn">
          {t.ai.installHelp}{' '}
          <a href={INSTALL_URL} target="_blank" rel="noreferrer">
            {t.ai.installLink}
          </a>
        </Notice>
      ) : null}
      {claude.installed && !claude.loggedIn ? <Notice tone="warn">{t.ai.loginHelp}</Notice> : null}
      {status.billing ? <Notice tone="err">{t.ai.billingWarning}</Notice> : null}
      {status.queue?.pausedUntil ? <Notice tone="info">{pauseText(status.queue)}</Notice> : null}
      {status.queue?.blocked ? <Notice tone="warn">{t.ai.blocked[status.queue.blocked] ?? t.ai.blocked.other}</Notice> : null}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  )
}

/**
 * The league queue's state next to a waiting job: paused for a usage limit
 * (until when), blocked on sign-in or a missing claude command (with the
 * 다시 확인 button), and why the job's last try didn't finish.
 */
export function QueueNotice({ status, job, onChange }: { status: AiStatus | null; job?: JobInfo | null; onChange: (s: AiStatus) => void }) {
  const { busy, error, recheck } = useRecheck(onChange)
  const queue = status?.queue ?? null
  const waiting = job && (job.status === 'queued' || job.status === 'running')
  const lastTry = waiting && job.errorKind ? t.ai.lastTry(t.ai.errorKinds[job.errorKind] ?? job.errorKind, job.error ?? '') : null
  if (!queue?.pausedUntil && !queue?.blocked && !lastTry && !error) return null
  return (
    <div>
      {queue?.pausedUntil ? <Notice tone="info">{pauseText(queue)}</Notice> : null}
      {queue?.blocked ? (
        <Notice tone="warn">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t.ai.blocked[queue.blocked] ?? t.ai.blocked.other}</span>
            <button className="btn small" disabled={busy} onClick={() => void recheck()}>
              {t.ai.recheck}
            </button>
          </div>
        </Notice>
      ) : null}
      {lastTry ? <p className="help">{lastTry}</p> : null}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  )
}
