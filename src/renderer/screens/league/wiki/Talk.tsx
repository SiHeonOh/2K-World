import { useEffect, useState } from 'react'
import type { WikiTalkLine, WikiThreadSummary } from '@shared/wiki'
import { call } from '../../../api'
import { ErrorBox, Loading, Marked } from '../../../components/ui'
import { useLoad, usePush } from '../../../hooks'
import { t } from '../../../i18n'
import { useLeague } from '../LeagueLayout'
import { RuleErrors } from '../RuleErrors'
import { stamp, unsaved, type Go } from './nav'

const tw = t.wiki

const who = (a: { kind: string; nick: string }) => tw.author[a.kind] ?? a.nick

/** While a 토론 box holds text, leaving asks first (as the page editor does). */
function useDraftGuard(dirty: boolean): void {
  useEffect(() => {
    unsaved.current = dirty
  }, [dirty])
  useEffect(
    () => () => {
      unsaved.current = false
    },
    [],
  )
}

function Badges({ th }: { th: WikiThreadSummary }) {
  return (
    <>
      <span className={`wk-badge ${th.origin}`}>{tw.origins[th.origin]}</span>
      <span className={`wk-badge ${th.status}`}>{tw.status[th.status]}</span>
    </>
  )
}

/** A page's 토론: its threads (open first) and a form to open one. */
export function TalkList({ title, go }: { title: string; go: (next: Go) => void }) {
  const { league } = useLeague()
  // Kept on screen while it reloads, so a push never takes the form away mid-word.
  const list = useLoad(() => call('wiki.threads', league.slug, title), [title], { keepPrevious: true })
  usePush(league.slug, ['wiki'], list.reload)
  const [topic, setTopic] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useDraftGuard(topic.trim() !== '' || body.trim() !== '')
  const open = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await call('wiki.openThread', league.slug, { title, topic, body })
      unsaved.current = false
      go({ page: title, v: 'thread', t: r.id })
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.talkTitle(title)}</h1>
        <div className="wk-tools">
          <button onClick={() => go({ page: title })}>{tw.toPage}</button>
        </div>
      </header>
      {list.value.length === 0 ? (
        <p className="wk-empty">{tw.noThreads}</p>
      ) : (
        <ul className="wk-threads">
          {list.value.map((th) => (
            <li key={th.id}>
              <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), go({ page: title, v: 'thread', t: th.id }))}>
                {th.topic}
              </a>{' '}
              <Badges th={th} />
              <div className="wk-thread-meta">
                {th.section ? `${tw.inSection(th.section)} · ` : ''}
                {tw.commentCount(th.comments)} · {stamp(th.updatedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
      <section className="wk-newthread">
        <h2>{tw.newThread}</h2>
        <input value={topic} maxLength={60} placeholder={tw.topicPlaceholder} aria-label={tw.topic} onChange={(e) => setTopic(e.target.value)} />
        <textarea value={body} maxLength={2000} placeholder={tw.commentPlaceholder} aria-label={tw.firstComment} onChange={(e) => setBody(e.target.value)} />
        <div>
          <button className="btn primary small" disabled={busy || !topic.trim() || !body.trim()} onClick={() => void open()}>
            {tw.openThread}
          </button>
        </div>
        {error ? <RuleErrors error={error} /> : null}
      </section>
    </article>
  )
}

function Line({ line, opener, page, go }: { line: WikiTalkLine; opener: string; page: string; go: (next: Go) => void }) {
  if (line.kind === 'status') {
    return (
      <div className="wk-res-status">
        {who(line.author)} · {line.body}
        {line.rev && line.rev > 1 ? (
          <>
            {' '}
            <button className="wk-linkbtn" onClick={() => go({ page, v: 'diff', from: line.rev! - 1, to: line.rev! })}>
              {tw.compare}
            </button>
          </>
        ) : null}
      </div>
    )
  }
  return (
    <div className={`wk-res ${line.author.kind}${line.author.id === opener ? ' op' : ''}`}>
      <div className="wk-res-head">
        <span>
          #{line.n} <b>{who(line.author)}</b>
        </span>
        <span>{stamp(line.createdAt)}</span>
      </div>
      <div className="wk-res-body">
        <Marked text={line.body} numbers={line.flags} />
      </div>
    </div>
  )
}

/** One thread, Namuwiki-style: numbered comments, grey status lines, your reply box, and close / reopen. */
export function ThreadView({ id, go }: { id: number; go: (next: Go) => void }) {
  const { league } = useLeague()
  // Editors' answers show up by themselves; the thread stays on screen (and your reply box focused) meanwhile.
  const view = useLoad(() => call('wiki.thread', league.slug, id), [id], { keepPrevious: true })
  usePush(league.slug, ['wiki'], view.reload)
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // Only while the reply box is there: a closed thread has none.
  useDraftGuard(view.state === 'ready' && view.value.status === 'open' && body.trim() !== '')
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      after?.()
      view.reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  if (view.state === 'loading') return <Loading />
  if (view.state === 'error') return <ErrorBox error={view.error} onRetry={view.reload} />
  const th = view.value
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{th.topic}</h1>
        <div className="wk-tools">
          <button onClick={() => go({ page: th.pageTitle })}>{tw.toPage}</button>
          <button onClick={() => go({ page: th.pageTitle, v: 'talk' })}>{tw.toThreads}</button>
        </div>
      </header>
      <div className="wk-thread-meta">
        <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), go({ page: th.pageTitle }))}>
          {th.pageTitle}
        </a>
        {th.section ? ` · ${tw.inSection(th.section)}` : ''} <Badges th={th} />
      </div>
      <div className="wk-talk">
        {th.lines.map((l) => (
          <Line key={l.seq} line={l} opener={th.openedBy.id} page={th.pageTitle} go={go} />
        ))}
      </div>
      {th.replying ? <p className="wk-replying">{tw.replying}</p> : null}
      {th.status === 'open' ? (
        <section className="wk-reply">
          <textarea value={body} maxLength={2000} placeholder={tw.commentPlaceholder} aria-label={tw.post} onChange={(e) => setBody(e.target.value)} />
          <div className="wk-reply-row">
            <button className="btn primary small" disabled={busy || !body.trim()} onClick={() => void act(() => call('wiki.comment', league.slug, id, body), () => setBody(''))}>
              {tw.post}
            </button>
            <span className="wk-grow" />
            <input value={note} maxLength={300} placeholder={tw.closeNotePlaceholder} aria-label={tw.closeNotePlaceholder} onChange={(e) => setNote(e.target.value)} />
            <button className="btn ghost small" disabled={busy} onClick={() => void act(() => call('wiki.setThread', league.slug, id, false, note), () => setNote(''))}>
              {tw.closeThread}
            </button>
          </div>
        </section>
      ) : (
        <div className="wk-oldrev">
          {tw.closed(th.closeNote)}{' '}
          <button className="btn small" disabled={busy} onClick={() => void act(() => call('wiki.setThread', league.slug, id, true, ''))}>
            {tw.reopenThread}
          </button>
        </div>
      )}
      {error ? <RuleErrors error={error} /> : null}
    </article>
  )
}

/** 최근 토론: threads across the wiki with the latest activity. */
export function RecentTalk({ go }: { go: (next: Go) => void }) {
  const { league } = useLeague()
  const list = useLoad(() => call('wiki.recentThreads', league.slug), [league.slug], { keepPrevious: true })
  usePush(league.slug, ['wiki'], list.reload)
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  const c = tw.talkColumns
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.recentTalk}</h1>
      </header>
      {list.value.length === 0 ? (
        <p className="wk-empty">{tw.noRecentTalk}</p>
      ) : (
        <table className="wk-revs">
          <thead>
            <tr>
              <th>{c.page}</th>
              <th>{c.topic}</th>
              <th>{c.kind}</th>
              <th>{c.comments}</th>
              <th>{c.time}</th>
            </tr>
          </thead>
          <tbody>
            {list.value.map((th) => (
              <tr key={th.id}>
                <td>
                  <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), go({ page: th.pageTitle }))}>
                    {th.pageTitle}
                  </a>
                </td>
                <td>
                  <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), go({ page: th.pageTitle, v: 'thread', t: th.id }))}>
                    {th.topic}
                  </a>
                </td>
                <td>
                  <Badges th={th} />
                </td>
                <td>{th.comments}</td>
                <td>{stamp(th.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  )
}
