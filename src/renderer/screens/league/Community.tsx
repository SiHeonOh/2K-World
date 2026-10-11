import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router'
import type { AuthorView, CommentView, PollView, PostSummary, PostView, RefreshResult } from '@shared/community'
import { cleanOptions, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from '@shared/polls'
import { call } from '../../api'
import { ErrorBox, Loading, Marked } from '../../components/ui'
import { useLoad, usePush } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { useRoundName } from './Played'
import { RuleErrors } from './RuleErrors'

const tc = t.community
const tp = tc.poll

/** How often a page looks again while comments trickle in or a writer is busy. */
const POLL_MS = 15_000
/** How often a post looks again when only its poll's votes are still coming (they take hours). */
const VOTES_POLL_MS = 60_000
/** The longest wait a timer takes (setTimeout's limit). */
const MAX_TIMER_MS = 2_147_483_647
/** How long to keep looking while only a writer is busy: a usage limit can hold a job for hours. */
const WRITER_POLL_FOR = 10 * 60_000
/** The highest page the main process accepts. */
const MAX_PAGE = 100_000

/** Text typed in the post or comment form, which leaving the page would throw away. */
type DraftRef = RefObject<boolean>

/** A positive whole number from a URL param, or null for anything else. */
function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 ? n : null
}

/** The community's address: the board, then the page and the post when there are any. */
function searchFor(next: { b: string; p?: number; post?: number | null }): URLSearchParams {
  const p = new URLSearchParams()
  p.set('b', next.b)
  if (next.p && next.p > 1) p.set('p', String(next.p))
  if (next.post) p.set('post', String(next.post))
  return p
}

/** Board list time: HH:MM today, MM.DD before. */
function when(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  const mins = Math.floor((now - d.getTime()) / 60_000)
  if (mins < 1) return tc.justNow
  if (mins < 60) return tc.minutesAgo(mins)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function Author({ a }: { a: AuthorView }) {
  return (
    <span className={`cm-author${a.kind === 'user' ? ' me' : ''}`} title={a.badge && a.kind === 'fan' ? `${a.nick} · ${a.badge}` : a.nick}>
      <span className={`cm-level l${Math.min(5, Math.ceil(a.level / 6))}`} title={tc.level(a.level)}>
        {a.kind === 'reporter' ? tc.reporter : a.level}
      </span>
      <span className="cm-nick">{a.nick}</span>
      {a.badge && a.kind === 'fan' ? <span className="cm-badge">{a.badge}</span> : null}
    </span>
  )
}

/** Keeps a form's "has text" flag in the shared ref; cleared when the form goes away. */
function useDraftFlag(draft: DraftRef, hasText: boolean) {
  useEffect(() => {
    draft.current = hasText
    return () => {
      draft.current = false
    }
  }, [draft, hasText])
}

/** The community: boards, posts and comments in a familiar board layout; refresh shows what's new. */
export function Community() {
  const { league } = useLeague()
  const [params, setParams] = useSearchParams()
  const boards = league.config.community.boards
  const mainBoard = boards.find((b) => b.role === 'main') ?? boards[0]!
  // A bad or stale address falls back: an unknown board to the main one; a page or post that isn't a positive whole number is ignored.
  const boardId = boards.find((b) => b.id === params.get('b'))?.id ?? mainBoard.id
  const postId = positiveInt(params.get('post'))
  const page = Math.min(positiveInt(params.get('p')) ?? 1, MAX_PAGE)
  const [writing, setWriting] = useState(false)
  const [tick, setTick] = useState(0)
  const [statusTick, setStatusTick] = useState(0)
  const [refresh, setRefresh] = useState<{ busy: boolean; result: RefreshResult | null; error: unknown }>({ busy: false, result: null, error: null })
  const status = useLoad(() => call('community.status', league.slug), [league.slug, tick, statusTick], { keepPrevious: true })
  const draft = useRef(false)
  const statusSince = useRef<number | null>(null)

  // Put the address in its tidy form (dropping what was ignored above) without adding a history entry.
  const canonical = searchFor({ b: boardId, p: page, post: postId }).toString()
  useEffect(() => {
    if (params.toString() !== canonical) setParams(new URLSearchParams(canonical), { replace: true })
  }, [params, canonical, setParams])

  // Something you did may have queued a writer: look at the status again (and restart its time limit).
  const changed = () => {
    statusSince.current = null
    setTick((x) => x + 1)
  }
  // A writer finishing (a game thread, an article, replies to you) shows up at once: the list and the post look again.
  usePush(league.slug, ['community'], () => setTick((x) => x + 1))

  // While writers are busy, the top bar's count follows them, for a while.
  const writersBusy = status.state === 'ready' ? status.value.writing : 0
  useEffect(() => {
    if (writersBusy === 0) {
      statusSince.current = null
      return
    }
    const since = (statusSince.current ??= Date.now())
    if (Date.now() - since >= WRITER_POLL_FOR) return
    const timer = setTimeout(() => setStatusTick((x) => x + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [writersBusy, statusTick, tick])

  const go = (next: { b?: string; p?: number; post?: number | null }, options: { replace?: boolean } = {}) => {
    if (!options.replace && draft.current && !window.confirm(tc.leaveDraft)) return
    draft.current = false
    setWriting(false)
    setParams(searchFor({ b: next.b ?? boardId, p: next.p, post: next.post }), { replace: options.replace })
  }

  const doRefresh = async () => {
    if (refresh.busy) return
    setRefresh({ busy: true, result: null, error: null })
    try {
      const result = await call('community.refresh', league.slug)
      setRefresh({ busy: false, result, error: null })
      changed()
    } catch (error) {
      setRefresh({ busy: false, result: null, error })
    }
  }

  const s = status.state === 'ready' ? status.value : null
  const enabled = league.config.community.enabled
  return (
    <div className="page wide cm">
      <div className="cm-top">
        <div className="cm-brand">{tc.brand(league.config.league.shortName || league.config.league.name)}</div>
        <nav className="cm-boards" aria-label={tc.board}>
          {boards.map((b) => {
            const active = b.id === boardId && postId === null
            return (
              <button
                key={b.id}
                className={`cm-board${active ? ' active' : ''}${b.role === 'poten' ? ' poten' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => go({ b: b.id })}
              >
                {b.name}
              </button>
            )
          })}
        </nav>
        <div className="cm-tools">
          {s ? (
            <span className="cm-status" aria-live="polite">
              {s.writing > 0 ? tc.writing(s.writing) : null} {s.waiting > 0 ? tc.waitingItems(s.waiting) : null}
            </span>
          ) : null}
          <button className="btn primary small" disabled={refresh.busy} onClick={() => void doRefresh()}>
            {refresh.busy ? tc.refreshing : tc.refresh}
          </button>
        </div>
      </div>
      {!enabled ? <div className="cm-note">{tc.disabled}</div> : s && !s.aiReady ? <div className="cm-note">{tc.aiNotReady}</div> : null}
      {refresh.result ? (
        <div className="cm-note">
          {tc.refreshed(refresh.result.revealed)} {refresh.result.budgetSpent ? tc.budgetSpent : refresh.result.refilling ? tc.refilling : ''}
        </div>
      ) : null}
      {refresh.error ? <ErrorBox error={refresh.error} /> : null}

      {postId !== null ? (
        <PostPage
          key={postId}
          postId={postId}
          tick={tick}
          draft={draft}
          onBack={() => go({ b: boardId, p: page })}
          onOpen={(id) => go({ b: boardId, p: page, post: id })}
          onChanged={changed}
        />
      ) : writing ? (
        <WriteForm
          boardId={boardId}
          draft={draft}
          onCancel={() => setWriting(false)}
          onDone={(id, board) => {
            draft.current = false
            changed()
            go({ b: board, post: id })
          }}
        />
      ) : (
        <div className="cm-main">
          <BoardList
            boardId={boardId}
            page={page}
            tick={tick}
            onOpen={(id) => go({ b: boardId, p: page, post: id })}
            onPage={(p, replace) => go({ b: boardId, p }, { replace })}
            onWrite={() => setWriting(true)}
          />
          <aside className="cm-side">
            <NewsBox enabled={enabled} aiReady={s?.aiReady ?? true} onSent={changed} />
          </aside>
        </div>
      )}
    </div>
  )
}

function BoardList({
  boardId,
  page,
  tick,
  onOpen,
  onPage,
  onWrite,
}: {
  boardId: string
  page: number
  tick: number
  onOpen: (id: number) => void
  onPage: (p: number, replace?: boolean) => void
  onWrite: () => void
}) {
  const { league } = useLeague()
  const board = league.config.community.boards.find((b) => b.id === boardId)
  // `asked` tells this answer apart from the previous page's while the next one loads.
  const list = useLoad(
    () => call('community.board', league.slug, boardId, page).then((v) => ({ ...v, asked: page })),
    [`${boardId}:${page}`, tick],
    { keepPrevious: true },
  )
  const shown = list.state === 'ready' ? list.value : null
  // Past the last page (an old link, posts gone to 포텐): the server shows the last one; the address follows.
  useEffect(() => {
    if (shown && shown.asked === page && shown.boardId === boardId && shown.page !== page) onPage(shown.page, true)
  }, [shown, page, boardId, onPage])
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <RuleErrors error={list.error} onRetry={list.reload} />
  const { posts, pages, page: current } = list.value
  const poten = board?.role === 'poten'
  return (
    <div className="cm-list">
      <div className="cm-list-head">
        <h2>{board?.name}</h2>
        {!poten ? (
          <button className="btn small" onClick={onWrite}>
            {tc.write}
          </button>
        ) : null}
      </div>
      <table className="cm-table">
        <thead>
          <tr>
            <th className="no">{tc.columns.no}</th>
            <th className="title">{tc.columns.title}</th>
            <th className="author">{tc.columns.author}</th>
            <th className="date">{tc.columns.date}</th>
            <th className="num">{tc.columns.views}</th>
            <th className="num">{tc.columns.up}</th>
          </tr>
        </thead>
        <tbody>
          {posts.length === 0 ? (
            <tr>
              <td colSpan={6} className="cm-empty">
                {poten ? tc.emptyPoten(league.config.community.potenAt) : tc.empty}
              </td>
            </tr>
          ) : (
            posts.map((p) => <Row key={p.id} post={p} onOpen={onOpen} />)
          )}
        </tbody>
      </table>
      {pages > 1 ? (
        <div className="cm-pager">
          <button className="btn small ghost" disabled={current <= 1} onClick={() => onPage(current - 1)}>
            {tc.prev}
          </button>
          <span>{tc.page(current, pages)}</span>
          <button className="btn small ghost" disabled={current >= pages} onClick={() => onPage(current + 1)}>
            {tc.next}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Row({ post, onOpen }: { post: PostSummary; onOpen: (id: number) => void }) {
  const kind = tc.kinds[post.kind]
  return (
    <tr className={post.author.kind === 'user' ? 'mine' : undefined}>
      <td className="no">{post.poten ? <span className="cm-poten">{tc.poten}</span> : post.id}</td>
      <td className="title">
        <button className="cm-title" title={post.title} onClick={() => onOpen(post.id)}>
          {kind ? <span className={`cm-tag ${post.kind}`}>{kind}</span> : null}
          {post.pollState ? (
            <span className={`cm-poll-tag${post.pollState === 'closed' ? ' closed' : ''}`}>{post.pollState === 'open' ? tp.badge : tp.closedBadge}</span>
          ) : null}
          {/* A poll post's [투표] 말머리 would just repeat the badge. */}
          {post.tag && !(post.pollState && post.tag === tp.badge) ? <span className="cm-tag">[{post.tag}]</span> : null}
          <span className="cm-title-text">{post.title}</span>
          {post.comments > 0 ? <span className="cm-count">[{post.comments}]</span> : null}
          {post.fresh ? <span className="cm-fresh">{tc.fresh}</span> : null}
        </button>
      </td>
      <td className="author">
        <Author a={post.author} />
      </td>
      <td className="date">{when(post.shownAt)}</td>
      <td className="num">{post.views}</td>
      <td className="num">{post.up}</td>
    </tr>
  )
}

type Vote = (target: 'post' | 'comment', id: number, value: 1 | -1) => void

/** A vote click; the second click of a double-click is not a second vote (voting the same way again takes it back). */
const voteClick = (vote: () => void) => (e: MouseEvent) => {
  if (e.detail > 1) return
  vote()
}

function PostPage({
  postId,
  tick,
  draft,
  onBack,
  onOpen,
  onChanged,
}: {
  postId: number
  tick: number
  draft: DraftRef
  onBack: () => void
  /** Another post: a poll's results, or the poll a results post reports. */
  onOpen: (id: number) => void
  onChanged: () => void
}) {
  const { league } = useLeague()
  const [local, setLocal] = useState(0)
  // Opening the post is a view; this page reading it again (comments or votes arriving, a vote, a writer finishing) isn't.
  const opened = useRef(false)
  const view = useLoad(
    () =>
      call('community.post', league.slug, postId, opened.current).then((v) => {
        opened.current = true
        return v
      }),
    [postId, tick, local],
    { keepPrevious: true },
  )
  const [error, setError] = useState<unknown>(null)
  const [replyTo, setReplyTo] = useState<CommentView | null>(null)
  const value = view.state === 'ready' ? view.value : null
  const failed = view.state === 'error' ? view.error : null
  // The last post shown: a failed refetch (a vote, a refresh, a poll) keeps it on screen, and the comment you're typing with it.
  const [last, setLast] = useState<PostView | null>(null)
  useEffect(() => {
    if (value) setLast(value)
  }, [value])
  const post = value ?? last

  // One vote at a time: the next waits until the post has been read back with this one counted.
  const voting = useRef<'idle' | 'sending' | 'reloading'>('idle')
  const [voteBusy, setVoteBusy] = useState(false)
  useEffect(() => {
    if (voting.current !== 'reloading' || view.state === 'loading' || view.refreshing) return
    voting.current = 'idle'
    setVoteBusy(false)
  }, [value, failed, view.state, view.refreshing])

  // Look again every 15 seconds while comments are still to appear, or (for a while) while a reply is being written;
  // once a minute when only an open poll's votes are still coming, since they take hours.
  const comments = value?.pending ?? 0
  const votes = value?.poll?.open ? value.poll.pending : 0
  const writerBusy = value?.writing ?? false
  const writerSince = useRef<number | null>(null)
  useEffect(() => {
    if (!value) return
    const since = writerBusy ? (writerSince.current ??= Date.now()) : (writerSince.current = null)
    const waitForWriter = since !== null && Date.now() - since < WRITER_POLL_FOR
    if (comments === 0 && votes === 0 && !waitForWriter) return
    const timer = setTimeout(() => setLocal((x) => x + 1), comments > 0 || waitForWriter ? POLL_MS : VOTES_POLL_MS)
    return () => clearTimeout(timer)
  }, [value, comments, votes, writerBusy])

  // An open poll with a closing time looks again just after it, so the box doesn't keep offering votes.
  const closesAt = value?.poll?.open ? value.poll.closesAt : null
  useEffect(() => {
    if (closesAt === null) return
    const timer = setTimeout(() => setLocal((x) => x + 1), Math.min(Math.max(0, Date.parse(closesAt) - Date.now()) + 1000, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [closesAt])

  if (!post) {
    if (!failed) return <Loading />
    return (
      <div className="cm-post">
        <div className="cm-crumb">
          <button className="btn small ghost" onClick={onBack}>
            {tc.list}
          </button>
        </div>
        <RuleErrors error={failed} onRetry={view.reload} />
      </div>
    )
  }
  const board = league.config.community.boards.find((b) => b.id === post.boardId)

  const voteOn: Vote = async (target, id, v) => {
    if (voting.current !== 'idle') return
    voting.current = 'sending'
    setVoteBusy(true)
    setError(null)
    try {
      await call('community.vote', league.slug, target, id, v)
      voting.current = 'reloading'
      setLocal((x) => x + 1)
    } catch (e) {
      voting.current = 'idle'
      setVoteBusy(false)
      setError(e)
    }
  }

  return (
    <div className="cm-post">
      {failed ? (
        <div className="cm-stale">
          <span>{tc.reloadFailed}</span>
          <RuleErrors error={failed} onRetry={view.reload} />
        </div>
      ) : null}
      <div className="cm-post-head">
        <div className="cm-crumb">
          <button className="btn small ghost" onClick={onBack}>
            {tc.list}
          </button>
          <span>{board?.name}</span>
        </div>
        <h1>
          {post.tag ? <span className="cm-tag">[{post.tag}]</span> : null}
          <Marked text={post.title} numbers={post.flags} />
        </h1>
        <div className="cm-meta">
          <Author a={post.author} />
          <span>{new Date(post.shownAt).toLocaleString('ko-KR')}</span>
          <span>{tc.views(post.views)}</span>
          <span>{tc.ups(post.up)}</span>
          <span>{tc.comments(post.comments)}</span>
        </div>
      </div>
      <div className="cm-body">
        <Marked text={post.body} numbers={post.flags} />
      </div>
      {post.poll ? <PollBox poll={post.poll} onVoted={() => setLocal((x) => x + 1)} onOpen={onOpen} /> : null}
      {post.resultsOf !== null ? (
        <div>
          <button className="btn small ghost" onClick={() => onOpen(post.resultsOf!)}>
            {tp.resultsOf}
          </button>
        </div>
      ) : null}
      <div className="cm-votes">
        <button
          className={`cm-vote up${post.myVote === 1 ? ' on' : ''}`}
          aria-pressed={post.myVote === 1}
          disabled={voteBusy}
          onClick={voteClick(() => void voteOn('post', post.id, 1))}
        >
          {tc.upvote} <b>{post.up}</b>
        </button>
        <button
          className={`cm-vote down${post.myVote === -1 ? ' on' : ''}`}
          aria-pressed={post.myVote === -1}
          disabled={voteBusy}
          onClick={voteClick(() => void voteOn('post', post.id, -1))}
        >
          {tc.downvote} <b>{post.down}</b>
        </button>
      </div>
      {error ? <RuleErrors error={error} /> : null}

      {post.best.length > 0 ? (
        <div className="cm-best">
          <h3>{tc.bestTitle}</h3>
          {post.best.map((c) => (
            <Comment key={c.id} c={c} best voteBusy={voteBusy} onVote={voteOn} onReply={setReplyTo} />
          ))}
        </div>
      ) : null}

      <div className="cm-comments">
        <h3>{tc.comments(post.comments)}</h3>
        {post.thread.map((c) => (
          <Comment key={c.id} c={c} voteBusy={voteBusy} onVote={voteOn} onReply={setReplyTo} />
        ))}
        {post.pending > 0 ? <div className="cm-pending">{tc.pending(post.pending)}</div> : null}
      </div>
      <CommentForm
        post={post}
        replyTo={replyTo}
        draft={draft}
        onClearReply={() => setReplyTo(null)}
        onDone={() => {
          setReplyTo(null)
          // A reply to you is now queued: give it the full time to arrive.
          writerSince.current = null
          setLocal((x) => x + 1)
          onChanged()
        }}
      />
    </div>
  )
}

/**
 * A post's poll: a bar per option with the votes shown so far (fans' votes
 * keep arriving), your pick, and vote or change buttons while it's open;
 * closed, the final result and a link to the results post.
 */
function PollBox({ poll: loaded, onVoted, onOpen }: { poll: PollView; onVoted: () => void; onOpen: (id: number) => void }) {
  const { league } = useLeague()
  const roundName = useRoundName('short')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // The answer to your vote shows at once, until the post is read back with it.
  const [voted, setVoted] = useState<PollView | null>(null)
  useEffect(() => setVoted(null), [loaded])
  const poll = voted ?? loaded
  const vote = async (option: number) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setVoted(await call('community.pollVote', league.slug, poll.id, option))
      onVoted()
    } catch (e) {
      setError(e)
      // It may have closed meanwhile: show it as it is now.
      onVoted()
    } finally {
      setBusy(false)
    }
  }
  const top = Math.max(...poll.options.map((o) => o.votes))
  const winners = poll.total > 0 ? poll.options.filter((o) => o.votes === top).map((o) => o.text) : []
  return (
    <section className={`cm-poll${poll.open ? '' : ' closed'}`} aria-label={tp.label}>
      <div className="cm-poll-head">
        <span className="cm-poll-badge">{poll.open ? tp.badge : tp.closedBadge}</span>
        <b className="cm-poll-q">{poll.question}</b>
      </div>
      <ol className="cm-poll-options">
        {poll.options.map((o, i) => {
          const pct = Math.round(o.share * 100)
          const mine = poll.myVote === i
          const lead = !poll.open && poll.total > 0 && o.votes === top
          return (
            <li key={i} className={`cm-poll-option${mine ? ' mine' : ''}${lead ? ' lead' : ''}`}>
              <div className="cm-poll-line">
                <span className="cm-poll-text">
                  {i + 1}. {o.text}
                  {/* While it's open, your option's button says so. */}
                  {mine && !poll.open ? <span className="cm-poll-picked">{tp.picked}</span> : null}
                </span>
                <span className="cm-poll-num">
                  {tp.votes(o.votes)} · {pct}%
                </span>
                {poll.open ? (
                  <button className="btn small" disabled={busy || mine} aria-pressed={mine} onClick={() => void vote(i)}>
                    {mine ? tp.picked : poll.myVote === null ? tp.vote : tp.change}
                  </button>
                ) : null}
              </div>
              <div className="cm-poll-bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ol>
      <div className="cm-poll-foot">
        <span>{tp.total(poll.total)}</span>
        {poll.open ? (
          <span>
            {poll.closesAfterRound !== null
              ? tp.closesAfterRound(poll.closesAfterRound, roundName)
              : poll.closesAt
                ? tp.closesAt(new Date(poll.closesAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
                : null}
          </span>
        ) : (
          <>
            <span className="cm-poll-final">
              {tp.closed} · {tp.final}: {winners.length === 0 ? tp.noVotes : winners.length > 1 ? tp.tied(winners.join(', ')) : tp.winner(winners[0]!)}
            </span>
            {poll.resultsPostId !== null ? (
              <button className="btn small ghost" onClick={() => onOpen(poll.resultsPostId!)}>
                {tp.results}
              </button>
            ) : poll.closedAt === null ? (
              <span className="sub">{tp.heldNote}</span>
            ) : null}
          </>
        )}
      </div>
      {error ? <RuleErrors error={error} /> : null}
    </section>
  )
}

function Comment({
  c,
  best,
  voteBusy,
  onVote,
  onReply,
}: {
  c: CommentView
  best?: boolean
  voteBusy: boolean
  onVote: Vote
  onReply: (c: CommentView) => void
}) {
  return (
    <div className={`cm-comment${c.parentId !== null && !best ? ' reply' : ''}${c.mine ? ' mine' : ''}${best ? ' best' : ''}`}>
      <div className="cm-comment-head">
        {c.best ? <span className="cm-best-tag">{tc.best}</span> : null}
        <Author a={c.author} />
        <span className="cm-time">{when(c.shownAt)}</span>
      </div>
      <div className="cm-comment-body">
        <Marked text={c.body} numbers={c.flags} />
      </div>
      <div className="cm-comment-tools">
        <button
          className={`cm-mini${c.myVote === 1 ? ' on' : ''}`}
          aria-label={tc.upvoteComment(c.up)}
          aria-pressed={c.myVote === 1}
          disabled={voteBusy}
          onClick={voteClick(() => onVote('comment', c.id, 1))}
        >
          ▲ {c.up}
        </button>
        <button
          className={`cm-mini${c.myVote === -1 ? ' on' : ''}`}
          aria-label={tc.downvoteComment(c.down)}
          aria-pressed={c.myVote === -1}
          disabled={voteBusy}
          onClick={voteClick(() => onVote('comment', c.id, -1))}
        >
          ▼ {c.down}
        </button>
        {!best ? (
          <button className="cm-mini" onClick={() => onReply(c)}>
            {tc.reply}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function CommentForm({
  post,
  replyTo,
  draft,
  onClearReply,
  onDone,
}: {
  post: PostView
  replyTo: CommentView | null
  draft: DraftRef
  onClearReply: () => void
  onDone: () => void
}) {
  const { league } = useLeague()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useDraftFlag(draft, body.trim() !== '')
  const send = async () => {
    if (busy || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      await call('community.comment', league.slug, { postId: post.id, body, ...(replyTo ? { parentId: replyTo.id } : {}) })
      setBody('')
      onDone()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cm-form">
      {replyTo ? (
        <div className="cm-replying">
          {tc.replyingTo(replyTo.author.nick)}
          <button className="cm-mini" aria-label={tc.cancelReply} title={tc.cancelReply} onClick={onClearReply}>
            ✕
          </button>
        </div>
      ) : null}
      <textarea
        value={body}
        placeholder={tc.commentPlaceholder}
        aria-label={replyTo ? tc.replyingTo(replyTo.author.nick) : tc.commentLabel}
        rows={3}
        maxLength={2000}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter while a Korean syllable is still being composed belongs to the IME.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {error ? <RuleErrors error={error} /> : null}
      <div className="cm-form-tools">
        <button className="btn primary small" disabled={busy || !body.trim()} onClick={() => void send()}>
          {tc.commentSubmit}
        </button>
      </div>
    </div>
  )
}

function WriteForm({
  boardId,
  draft,
  onCancel,
  onDone,
}: {
  boardId: string
  draft: DraftRef
  onCancel: () => void
  onDone: (id: number, boardId: string) => void
}) {
  const { league } = useLeague()
  const roundName = useRoundName('short')
  const boards = league.config.community.boards.filter((b) => b.role !== 'poten')
  const [board, setBoard] = useState(boards.some((b) => b.id === boardId) ? boardId : boards[0]!.id)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [live, setLive] = useState(false)
  const [gameId, setGameId] = useState<number | null>(null)
  const [pollOn, setPollOn] = useState(false)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const games = useLoad(() => call('season.games', league.slug), [league.slug])
  const short = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const open = games.state === 'ready' ? games.value.filter((g) => g.status === 'scheduled').slice(0, 30) : []
  // The options as the main process will store them (numbering, blanks and repeats gone).
  const distinct = cleanOptions(options).length
  const pollReady = !pollOn || (distinct >= POLL_MIN_OPTIONS && distinct <= POLL_MAX_OPTIONS)
  const hasText = title.trim() !== '' || body.trim() !== '' || (pollOn && (question.trim() !== '' || options.some((o) => o.trim() !== '')))
  useDraftFlag(draft, hasText)

  const send = async () => {
    if (busy || !title.trim() || !pollReady) return
    setBusy(true)
    setError(null)
    try {
      const { postId } = await call('community.write', league.slug, {
        boardId: board,
        title,
        body,
        ...(live && gameId ? { gameId } : {}),
        ...(pollOn ? { poll: { question, options } } : {}),
      })
      onDone(postId, board)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    if (hasText && !window.confirm(tc.discardDraft)) return
    onCancel()
  }

  return (
    <div className="cm-write card">
      <div className="cm-write-row">
        <select value={board} onChange={(e) => setBoard(e.target.value)} aria-label={tc.board}>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input value={title} placeholder={tc.titlePlaceholder} aria-label={tc.titleLabel} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <textarea value={body} placeholder={tc.bodyPlaceholder} aria-label={tc.bodyLabel} rows={10} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
      {pollOn ? (
        <fieldset className="cm-poll-edit">
          <legend>{tp.label}</legend>
          <input value={question} placeholder={tp.questionPlaceholder} aria-label={tp.question} maxLength={80} onChange={(e) => setQuestion(e.target.value)} />
          {options.map((o, i) => (
            <div key={i} className="cm-write-row">
              <input
                value={o}
                placeholder={tp.option(i + 1)}
                aria-label={tp.option(i + 1)}
                maxLength={40}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 ? (
                <button className="cm-mini" aria-label={tp.removeOption(i + 1)} title={tp.removeOption(i + 1)} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  ✕
                </button>
              ) : null}
            </div>
          ))}
          <div className="cm-poll-edit-tools">
            {options.length < POLL_MAX_OPTIONS ? (
              <button className="btn small ghost" onClick={() => setOptions([...options, ''])}>
                {tp.addOption}
              </button>
            ) : null}
            <button className="btn small ghost" onClick={() => setPollOn(false)}>
              {tp.remove}
            </button>
          </div>
          <span className="sub">{pollReady ? tp.help : tp.needOptions}</span>
        </fieldset>
      ) : (
        <div>
          <button className="btn small ghost" onClick={() => setPollOn(true)}>
            {tp.add}
          </button>
        </div>
      )}
      <label className="cm-live">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> {tc.liveThread}
      </label>
      {live ? (
        <div className="cm-write-row">
          <select value={gameId ?? ''} onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : null)} aria-label={tc.pickGame}>
            <option value="">{tc.pickGame}</option>
            {open.map((g) => (
              <option key={g.id} value={g.id}>
                {g.stage === 'regular' ? roundName(g.round) : `R${g.round}`} {short(g.away)} @ {short(g.home)}
              </option>
            ))}
          </select>
          <span className="sub">{tc.liveHelp}</span>
        </div>
      ) : null}
      {error ? <RuleErrors error={error} /> : null}
      <div className="cm-form-tools">
        <button className="btn ghost small" onClick={cancel}>
          {tc.cancel}
        </button>
        <button className="btn primary small" disabled={busy || !title.trim() || (live && !gameId) || !pollReady} onClick={() => void send()}>
          {tc.submit}
        </button>
      </div>
    </div>
  )
}

function NewsBox({ enabled, aiReady, onSent }: { enabled: boolean; aiReady: boolean; onSent: () => void }): ReactNode {
  const { league } = useLeague()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const send = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    setSent(false)
    try {
      await call('community.news', league.slug, { text })
      setText('')
      setSent(true)
      onSent()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  // The event is kept either way, but no article gets written while the community is off or Claude Code isn't ready.
  const sentText = !enabled ? tc.news.sentOff : !aiReady ? tc.news.sentNoAi : tc.news.sent
  return (
    <div className="card cm-news">
      <h3>{tc.news.title}</h3>
      <p className="sub">{tc.news.help}</p>
      <textarea value={text} rows={4} maxLength={1000} placeholder={tc.news.placeholder} aria-label={tc.news.label} onChange={(e) => setText(e.target.value)} />
      {error ? <RuleErrors error={error} /> : null}
      {sent ? <div className="cm-note">{sentText}</div> : null}
      <button className="btn primary small" disabled={busy || !text.trim()} onClick={() => void send()}>
        {tc.news.submit}
      </button>
    </div>
  )
}
