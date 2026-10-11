import { useEffect, useState } from 'react'
import type { PushTopic } from '@shared/api'
import { call } from '../api'
import { useLoad, usePush } from '../hooks'
import { t } from '../i18n'
import { ErrorBox, Notice } from './ui'

const tq = t.ai.queue
/** The queue pausing, resuming or getting blocked sends a 'jobs' note, as finished jobs do. */
const JOBS_TOPIC: PushTopic[] = ['jobs']

/** "2분 뒤 다시 시도", or the clock time for a long wait (a usage limit's reset). */
export function retryWhen(pausedUntil: string, now: number): string {
  const ms = Date.parse(pausedUntil) - now
  if (!(ms > 60_000)) return tq.soon
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return tq.retryIn(minutes)
  return tq.retryAt(new Date(pausedUntil).toLocaleTimeString(t.app.locale, { hour: 'numeric', minute: '2-digit' }))
}

/**
 * Every league screen's note that the AI queue is paused (why, and when it
 * tries again) or blocked, with 지금 다시 시도 (다시 확인 for a block). It
 * looks again when the queue's state changes and keeps its countdown fresh.
 */
export function QueueBanner({ slug }: { slug: string }) {
  const status = useLoad(() => call('ai.status', slug), [slug], { keepPrevious: true })
  usePush(slug, JOBS_TOPIC, status.reload)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const queue = status.state === 'ready' ? status.value.queue : null
  const paused = queue?.pausedUntil ?? null
  const stopped = paused !== null || Boolean(queue?.blocked)
  useEffect(() => {
    if (!stopped) return
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [stopped])
  // A pause that should be over: the queue is trying again by now (a note comes if it pauses again).
  const reload = status.reload
  const over = paused !== null && Date.parse(paused) <= now
  useEffect(() => {
    if (over) reload()
  }, [over, reload])

  if (!queue || !stopped || over) return null
  const reason = queue.blocked ?? queue.pauseReason ?? 'failed'
  const resume = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('ai.resume', slug)
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="queue-banner" role="status">
      <Notice tone="warn">
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span>
            <b>{tq.stopped}</b>: {t.ai.reasons[reason] ?? reason} · {paused ? retryWhen(paused, now) : tq.waitsForFix}
          </span>
          <button className="btn small" disabled={busy} onClick={() => void resume()}>
            {queue.blocked ? t.ai.recheck : tq.resume}
          </button>
        </div>
        <details className="queue-details">
          <summary>{tq.details}</summary>
          <p>{t.ai.fixes[reason]}</p>
          {queue.detail ? (
            <>
              <div className="muted small">{tq.raw}</div>
              <pre className="raw-error">{queue.detail}</pre>
            </>
          ) : null}
        </details>
      </Notice>
      {error ? <ErrorBox error={error} /> : null}
    </div>
  )
}
