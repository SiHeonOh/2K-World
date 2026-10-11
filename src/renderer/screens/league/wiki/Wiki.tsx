import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { parseWiki } from '@shared/namumark'
import type { Infobox, WikiPageView, WikiRevisionView } from '@shared/wiki'
import { ApiError, call } from '../../../api'
import { ErrorBox, Loading } from '../../../components/ui'
import { useLoad, usePush } from '../../../hooks'
import { t } from '../../../i18n'
import { useLeague } from '../LeagueLayout'
import { RuleErrors } from '../RuleErrors'
import { WikiRender } from './WikiRender'
import { stamp, unsaved, type Go, type View } from './nav'
import { RecentTalk, TalkList, ThreadView } from './Talk'

const tw = t.wiki


const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' })

const isConflict = (e: unknown) => e instanceof ApiError && e.code === 'rule' && (e.shape.rules ?? []).some((r) => r.code === 'wiki-conflict')

/** The wiki: Namuwiki-style pages from the league data, edited by you and (later) AI editors. */
export function Wiki() {
  const { league } = useLeague()
  const [params, setParams] = useSearchParams()
  const view = (params.get('v') as View | null) ?? 'page'
  const title = params.get('page')
  const rev = params.get('rev') ? Number(params.get('rev')) : undefined
  const query = params.get('q') ?? ''
  const home = useLoad(() => call('wiki.home', league.slug), [league.slug])
  const [search, setSearch] = useState(query)

  const go = (next: Go) => {
    if (unsaved.current && !window.confirm(tw.leave)) return
    unsaved.current = false
    const p = new URLSearchParams()
    if (next.page) p.set('page', next.page)
    if (next.v && next.v !== 'page') p.set('v', next.v)
    if (next.rev) p.set('rev', String(next.rev))
    if (next.q) p.set('q', next.q)
    if (next.from) p.set('from', String(next.from))
    if (next.to) p.set('to', String(next.to))
    if (next.t) p.set('t', String(next.t))
    // The page scrolls to the anchor once it has loaded.
    if (next.anchor) p.set('a', next.anchor)
    setParams(p)
    if (!next.anchor) window.scrollTo?.(0, 0)
  }

  const doSearch = async () => {
    const q = search.trim()
    if (!q) return
    // An exact title goes straight to the page.
    const results = await call('wiki.search', league.slug, q).catch(() => [])
    if (results.some((r) => r.title === q)) go({ page: q })
    else go({ v: 'search', q })
  }
  const random = async () => {
    const r = await call('wiki.random', league.slug).catch(() => ({ title: null }))
    if (r.title) go({ page: r.title })
  }

  if (home.state === 'loading') return <div className="page"><Loading /></div>
  if (home.state === 'error') return <div className="page"><ErrorBox error={home.error} onRetry={home.reload} /></div>
  const current = title ?? home.value.title

  return (
    <div className="page wide wk">
      <div className="wk-top">
        <button className="wk-brand" onClick={() => go({ page: home.value.title })}>
          {tw.brand(league.config.league.shortName || league.config.league.name)}
        </button>
        <div className="wk-nav">
          <button onClick={() => go({ v: 'recent' })}>{tw.recent}</button>
          <button onClick={() => go({ v: 'talks' })}>{tw.recentTalk}</button>
          <button onClick={() => void random()}>{tw.random}</button>
        </div>
        <form
          className="wk-search"
          onSubmit={(e) => {
            e.preventDefault()
            void doSearch()
          }}
        >
          <input value={search} placeholder={tw.searchPlaceholder} onChange={(e) => setSearch(e.target.value)} aria-label={tw.search} />
          <button type="submit">{tw.search}</button>
        </form>
      </div>
      {view === 'recent' ? (
        <Recent onOpen={(p) => go({ page: p })} onDiff={(p, from, to) => go({ page: p, v: 'diff', from, to })} />
      ) : view === 'search' ? (
        <SearchResults query={query} onOpen={(p) => go({ page: p })} />
      ) : view === 'history' ? (
        <History
          title={current}
          onOpen={(p, r) => go({ page: p, ...(r ? { rev: r } : {}) })}
          onDiff={(from, to) => go({ page: current, v: 'diff', from, to })}
          onBack={() => go({ page: current })}
        />
      ) : view === 'diff' ? (
        <DiffView title={current} from={Number(params.get('from')) || 1} to={Number(params.get('to')) || 1} go={go} />
      ) : view === 'backlinks' ? (
        <Backlinks title={current} onOpen={(p) => go({ page: p })} onBack={() => go({ page: current })} />
      ) : view === 'talk' ? (
        <TalkList title={current} go={go} />
      ) : view === 'thread' ? (
        <ThreadView key={params.get('t') ?? ''} id={Number(params.get('t')) || 0} go={go} />
      ) : view === 'talks' ? (
        <RecentTalk go={go} />
      ) : (
        <PageScreen
          key={`${current}:${rev ?? ''}:${view}`}
          title={current}
          rev={rev}
          anchor={params.get('a')}
          editing={view === 'edit'}
          go={go}
        />
      )}
    </div>
  )
}

function InfoboxView({ box, onLink }: { box: Infobox; onLink: (t: string) => void }) {
  const color = box.colors[0] ?? '#00a495'
  const text = box.colors[1] ?? '#ffffff'
  return (
    <table className="wk-infobox">
      <thead>
        <tr>
          <th colSpan={2} style={{ background: color, color: text }}>
            <div className="wk-infobox-title">{box.title}</div>
            {box.subtitle ? <div className="wk-infobox-sub">{box.subtitle}</div> : null}
          </th>
        </tr>
      </thead>
      <tbody>
        {box.rows.map((r) => (
          <tr key={r.label}>
            <th style={{ background: `${color}22` }}>{r.label}</th>
            <td>
              {r.link ? (
                <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onLink(r.link!))}>
                  {r.value}
                </a>
              ) : (
                r.value
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PageScreen({
  title,
  rev,
  anchor,
  editing,
  go,
}: {
  title: string
  rev: number | undefined
  anchor: string | null
  editing: boolean
  go: (next: Go) => void
}) {
  const { league } = useLeague()
  const page = useLoad(() => call('wiki.page', league.slug, title, rev), [`${title}:${rev ?? ''}`])
  if (page.state === 'loading') return <Loading />
  if (page.state === 'error') return <ErrorBox error={page.error} onRetry={page.reload} />
  const p = page.value
  if (editing) return <Editor page={p} onDone={(saved) => go({ page: saved })} onCancel={() => go({ page: p.title })} />
  return <PageView page={p} go={go} anchor={anchor} />
}

function PageView({
  page: p,
  go,
  anchor,
}: {
  page: WikiPageView
  go: (next: Go) => void
  anchor: string | null
}) {
  const doc = useMemo(() => parseWiki(p.source), [p.source])
  const existing = useMemo(() => new Set(p.existing), [p.existing])
  useEffect(() => {
    if (anchor) jump(anchor)
  }, [anchor, p.source])
  // [[#s-2]] stays on this page; anything else opens the linked page.
  const onLink = (page: string, a: string | null) => (page ? go({ page, anchor: a }) : a ? jump(a) : undefined)
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{p.title}</h1>
        <div className="wk-tools">
          {p.exists ? (
            <>
              <button onClick={() => go({ page: p.title, v: 'edit' })}>{tw.edit}</button>
              <button className={p.talk.open ? 'wk-talk-on' : ''} onClick={() => go({ page: p.title, v: 'talk' })}>
                {tw.talk} {p.talk.open ? `(${p.talk.open})` : ''}
              </button>
              <button onClick={() => go({ page: p.title, v: 'history' })}>{tw.history}</button>
              <button onClick={() => go({ page: p.title, v: 'backlinks' })}>
                {tw.backlinks} {p.backlinks ? `(${p.backlinks})` : ''}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {doc.categories.length ? (
        <div className="wk-cats">
          {tw.categories}: {doc.categories.join(' · ')}
        </div>
      ) : null}
      {p.updatedAt ? <div className="wk-updated">{tw.lastEdit(stamp(p.updatedAt))}</div> : null}
      {p.talk.disputes.map((d) => (
        <div key={d.threadId} className="wk-dispute">
          {d.origin === 'pushback' ? tw.pushbackBanner(d.section) : tw.disputeBanner(d.section)}{' '}
          <button className="wk-linkbtn" onClick={() => go({ page: p.title, v: 'thread', t: d.threadId })}>
            {tw.toThread}
          </button>
        </div>
      ))}
      {p.rev !== null && p.latestRev !== null && p.rev !== p.latestRev ? (
        <div className="wk-oldrev">
          {tw.oldRev(p.rev, p.latestRev)}{' '}
          <button className="wk-linkbtn" onClick={() => go({ page: p.title })}>
            {tw.toLatest}
          </button>
        </div>
      ) : null}
      {p.flags.length ? <div className="wk-flagged-note">{tw.flaggedRev(p.flags.join(', '))}</div> : null}
      {!p.exists ? (
        <div className="wk-missing">
          <p>{tw.missing(p.title)}</p>
          {p.backlinks ? <p className="sub">{tw.missingBacklinks(p.backlinks)}</p> : null}
          <button className="btn primary small" onClick={() => go({ page: p.title, v: 'edit' })}>
            {tw.create}
          </button>
        </div>
      ) : (
        <div className="wk-content">
          {p.data.infobox ? <InfoboxView box={p.data.infobox} onLink={(page) => onLink(page, null)} /> : null}
          <WikiRender doc={doc} data={p.data} existing={existing} onLink={onLink} />
        </div>
      )}
    </article>
  )
}

function Editor({ page: p, onDone, onCancel }: { page: WikiPageView; onDone: (title: string) => void; onCancel: () => void }) {
  const { league } = useLeague()
  const [source, setSource] = useState(p.source)
  const [summary, setSummary] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const doc = useMemo(() => (preview ? parseWiki(source) : null), [preview, source])
  const changed = source !== p.source || summary !== ''
  useEffect(() => {
    unsaved.current = changed
  }, [changed])
  useEffect(
    () => () => {
      unsaved.current = false
    },
    [],
  )
  /** `onTopOf` saves over whatever is newest now (after a conflict, by your choice). */
  const save = async (onTopOf?: number | null) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const base = onTopOf !== undefined ? onTopOf : p.exists ? p.latestRev : null
      const r = await call('wiki.save', league.slug, { title: p.title, source, summary, baseRev: base })
      unsaved.current = false
      onDone(r.title)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  /** Someone saved in between: keep your text and save it over the newest revision. */
  const saveOverLatest = async () => {
    try {
      const latest = await call('wiki.page', league.slug, p.title)
      await save(latest.exists ? latest.latestRev : null)
    } catch (e) {
      setError(e)
    }
  }
  const cancel = () => {
    if (changed && !window.confirm(tw.leave)) return
    unsaved.current = false
    onCancel()
  }
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{p.exists ? tw.editing(p.title) : tw.creating(p.title)}</h1>
        <div className="wk-tools">
          <button className={preview ? '' : 'on'} onClick={() => setPreview(false)}>
            {tw.write}
          </button>
          <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
            {tw.preview}
          </button>
        </div>
      </header>
      {preview && doc ? (
        <div className="wk-content wk-preview">
          <WikiRender doc={doc} data={p.data} existing={new Set(p.existing)} onLink={() => {}} />
        </div>
      ) : (
        <>
          <textarea className="wk-editor" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} />
          <p className="sub wk-syntax">{tw.syntax}</p>
        </>
      )}
      <div className="wk-save">
        <input value={summary} placeholder={tw.summaryPlaceholder} maxLength={200} onChange={(e) => setSummary(e.target.value)} aria-label={tw.summary} />
        <button className="btn ghost small" onClick={cancel}>
          {tw.cancel}
        </button>
        <button className="btn primary small" disabled={busy || !source.trim()} onClick={() => void save()}>
          {tw.save}
        </button>
      </div>
      {error ? <RuleErrors error={error} /> : null}
      {isConflict(error) ? (
        <div className="wk-oldrev">
          {tw.conflict}{' '}
          <button className="btn small" disabled={busy} onClick={() => void saveOverLatest()}>
            {tw.saveOverLatest}
          </button>
        </div>
      ) : null}
    </article>
  )
}

function RevisionTable({
  rows,
  onOpen,
  lead,
  extra,
}: {
  rows: WikiRevisionView[]
  onOpen: (page: string, rev: number) => void
  /** A first cell per row (the 비교 picks). */
  lead?: (r: WikiRevisionView) => ReactNode
  extra?: (r: WikiRevisionView) => ReactNode
}) {
  return (
    <table className="wk-revs">
      <thead>
        <tr>
          {lead ? <th /> : null}
          <th>{tw.columns.rev}</th>
          <th>{tw.columns.time}</th>
          <th>{tw.columns.author}</th>
          <th>{tw.columns.summary}</th>
          <th>{tw.columns.size}</th>
          {extra ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.pageTitle}:${r.rev}`}>
            {lead ? <td className="wk-pick">{lead(r)}</td> : null}
            <td>
              <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onOpen(r.pageTitle, r.rev))}>
                {r.pageTitle} r{r.rev}
              </a>
            </td>
            <td>{stamp(r.createdAt)}</td>
            <td className={`wk-who ${r.author.kind}`}>{tw.author[r.author.kind] ?? r.author.nick}</td>
            <td>
              {r.summary}
              {r.flags.length ? (
                <span className="wk-flagged" title={tw.flaggedRev(r.flags.join(', '))}>
                  {tw.flaggedBadge}
                </span>
              ) : null}
            </td>
            <td className={r.sizeDelta >= 0 ? 'wk-plus' : 'wk-minus'}>{r.sizeDelta >= 0 ? `+${r.sizeDelta}` : r.sizeDelta}</td>
            {extra ? <td className="wk-acts">{extra(r)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function History({
  title,
  onOpen,
  onDiff,
  onBack,
}: {
  title: string
  onOpen: (page: string, rev?: number) => void
  onDiff: (from: number, to: number) => void
  onBack: () => void
}) {
  const { league } = useLeague()
  const [tick, setTick] = useState(0)
  const list = useLoad(() => call('wiki.history', league.slug, title), [title, tick])
  const [error, setError] = useState<unknown>(null)
  // The two revisions to compare (null: the newest two).
  const [picked, setPicked] = useState<{ from: number; to: number } | null>(null)
  const revert = async (r: WikiRevisionView) => {
    setError(null)
    try {
      const old = await call('wiki.page', league.slug, title, r.rev)
      await call('wiki.save', league.slug, { title, source: old.source, summary: tw.reverted(r.rev), baseRev: old.latestRev })
      setTick((x) => x + 1)
    } catch (e) {
      setError(e)
    }
  }
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  const latest = list.value[0]?.rev
  const pick = picked ?? { from: Math.max(1, (latest ?? 1) - 1), to: latest ?? 1 }
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.historyTitle(title)}</h1>
        <div className="wk-tools">
          <button onClick={onBack}>{tw.view}</button>
        </div>
      </header>
      {error ? <RuleErrors error={error} /> : null}
      {list.value.length > 1 ? (
        <div>
          <button className="btn small" disabled={pick.from === pick.to} onClick={() => onDiff(pick.from, pick.to)}>
            {tw.compareSelected}
          </button>
        </div>
      ) : null}
      <RevisionTable
        rows={list.value}
        onOpen={(p, r) => onOpen(p, r === latest ? undefined : r)}
        lead={
          list.value.length > 1
            ? (r) => (
                <>
                  <input
                    type="radio"
                    name="wk-from"
                    aria-label={tw.pickFrom(r.rev)}
                    checked={pick.from === r.rev}
                    disabled={r.rev >= pick.to}
                    onChange={() => setPicked({ ...pick, from: r.rev })}
                  />
                  <input
                    type="radio"
                    name="wk-to"
                    aria-label={tw.pickTo(r.rev)}
                    checked={pick.to === r.rev}
                    disabled={r.rev <= pick.from}
                    onChange={() => setPicked({ ...pick, to: r.rev })}
                  />
                </>
              )
            : undefined
        }
        extra={(r) => (
          <>
            {r.rev > 1 ? (
              <button className="wk-linkbtn" onClick={() => onDiff(r.rev - 1, r.rev)}>
                {tw.compare}
              </button>
            ) : null}
            {r.rev !== latest ? (
              <button className="wk-linkbtn" onClick={() => void revert(r)}>
                {tw.revert}
              </button>
            ) : null}
          </>
        )}
      />
    </article>
  )
}

/** 비교: the lines between two revisions, with the changed words marked, and steps to the next or previous change. */
function DiffView({ title, from, to, go }: { title: string; from: number; to: number; go: (next: Go) => void }) {
  const { league } = useLeague()
  const view = useLoad(() => call('wiki.diff', league.slug, title, from, to), [`${title}:${from}:${to}`])
  if (view.state === 'loading') return <Loading />
  if (view.state === 'error') return <ErrorBox error={view.error} onRetry={view.reload} />
  const d = view.value
  const a = d.from.rev
  const b = d.to.rev
  // One step at a time (as from history's 비교): the arrows walk through the page's edits.
  const step = b === a + 1
  const who = (r: WikiRevisionView) => `${tw.author[r.author.kind] ?? r.author.nick} · ${stamp(r.createdAt)}${r.summary ? ` · ${r.summary}` : ''}`
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.diffTitle(d.title)}</h1>
        <div className="wk-tools">
          <button onClick={() => go({ page: d.title, ...(b === d.latestRev ? {} : { rev: b }) })}>{tw.viewRev(b)}</button>
          <button onClick={() => go({ page: d.title, v: 'history' })}>{tw.history}</button>
        </div>
      </header>
      <div className="wk-diff-meta">
        <div>
          <b>r{a}</b> <span className={`wk-who ${d.from.author.kind}`}>{who(d.from)}</span>
        </div>
        <div>
          <b>r{b}</b> <span className={`wk-who ${d.to.author.kind}`}>{who(d.to)}</span>
        </div>
        <div className="wk-diff-nav">
          {step && a > 1 ? (
            <button className="wk-linkbtn" onClick={() => go({ page: d.title, v: 'diff', from: a - 1, to: a })}>
              {tw.prevDiff}
            </button>
          ) : null}
          <span>
            <span className="wk-plus">+{d.diff.added}</span> <span className="wk-minus">−{d.diff.removed}</span>
          </span>
          {step && b < d.latestRev ? (
            <button className="wk-linkbtn" onClick={() => go({ page: d.title, v: 'diff', from: b, to: b + 1 })}>
              {tw.nextDiff}
            </button>
          ) : null}
        </div>
      </div>
      {d.diff.added + d.diff.removed === 0 ? (
        <p className="wk-empty">{tw.noDiff}</p>
      ) : (
        <table className="wk-diff" aria-label={tw.diffCounts(d.diff.added, d.diff.removed)}>
          <tbody>
            {d.diff.rows.map((r, n) =>
              r.kind === 'skip' ? (
                <tr key={n} className="skip">
                  <td colSpan={4}>{tw.skipped(r.lines)}</td>
                </tr>
              ) : (
                <tr key={n} className={r.kind}>
                  <td className="no">{r.old ?? ''}</td>
                  <td className="no">{r.new ?? ''}</td>
                  <td className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                  <td className="txt">
                    {r.pieces.map((p, i) => (p.changed ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    {r.pieces.every((p) => p.text === '') ? ' ' : null}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </article>
  )
}

function Backlinks({ title, onOpen, onBack }: { title: string; onOpen: (page: string) => void; onBack: () => void }) {
  const { league } = useLeague()
  const list = useLoad(() => call('wiki.backlinks', league.slug, title), [title])
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.backlinksTitle(title)}</h1>
        <div className="wk-tools">
          <button onClick={onBack}>{tw.view}</button>
        </div>
      </header>
      {list.value.length === 0 ? (
        <p className="wk-empty">{tw.noBacklinks}</p>
      ) : (
        <ul className="wk-list">
          {list.value.map((p) => (
            <li key={p}>
              <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onOpen(p))}>
                {p}
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function Recent({ onOpen, onDiff }: { onOpen: (page: string) => void; onDiff: (page: string, from: number, to: number) => void }) {
  const { league } = useLeague()
  // New AI edits show up by themselves; the list stays on screen (and scrolled) while it reloads.
  const list = useLoad(() => call('wiki.recent', league.slug), [league.slug], { keepPrevious: true })
  usePush(league.slug, ['wiki'], list.reload)
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.recentTitle}</h1>
      </header>
      {list.value.length === 0 ? (
        <p className="wk-empty">{tw.noRecent}</p>
      ) : (
        <RevisionTable
          rows={list.value}
          onOpen={(p) => onOpen(p)}
          extra={(r) =>
            r.rev > 1 ? (
              <button className="wk-linkbtn" onClick={() => onDiff(r.pageTitle, r.rev - 1, r.rev)}>
                {tw.compare}
              </button>
            ) : null
          }
        />
      )}
    </article>
  )
}

function SearchResults({ query, onOpen }: { query: string; onOpen: (page: string) => void }) {
  const { league } = useLeague()
  const list = useLoad(() => call('wiki.search', league.slug, query), [query])
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  return (
    <article className="wk-page">
      <header className="wk-head">
        <h1>{tw.searchTitle(query)}</h1>
      </header>
      <p>
        <a href="#" className="wk-link missing" onClick={(e) => (e.preventDefault(), onOpen(query))}>
          {tw.goTo(query)}
        </a>
      </p>
      {list.value.length === 0 ? (
        <p className="wk-empty">{tw.noResults}</p>
      ) : (
        <ul className="wk-results">
          {list.value.map((r) => (
            <li key={r.title}>
              <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onOpen(r.title))}>
                {r.title}
              </a>{' '}
              <span className="wk-kind">{tw.kinds[r.kind]}</span>
              {r.snippet ? <div className="wk-snippet">…{r.snippet}…</div> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
