/** What the community screens show; built in the main process, read by the renderer. */

export type PostKind = 'thread' | 'article' | 'news' | 'user' | 'live'

export interface AuthorView {
  id: string
  nick: string
  kind: 'fan' | 'reporter' | 'user'
  level: number
  /** The school a fan backs (short name), or a reporter's outlet. */
  badge: string | null
}

export interface PostSummary {
  id: number
  boardId: string
  kind: PostKind
  tag: string | null
  title: string
  author: AuthorView
  /** Visible comments. */
  comments: number
  views: number
  up: number
  down: number
  poten: boolean
  shownAt: string
  /** It has comments that appeared since you last opened it. */
  fresh: boolean
  /** It carries a poll, still open or closed (null: no poll). */
  pollState: 'open' | 'closed' | null
}

export interface PollOptionView {
  text: string
  /** Votes shown so far (fans' votes arrive over hours; yours counts at once). */
  votes: number
  /** Share of the votes shown, 0–1. */
  share: number
}

export interface PollView {
  id: number
  question: string
  options: PollOptionView[]
  total: number
  /** Your pick (an option index), or null. */
  myVote: number | null
  open: boolean
  /**
   * How it closes: when the next regular-season round is complete (this one,
   * the first not complete when it opened; another finishing first closes it
   * too), or else at closesAt.
   */
  closesAfterRound: number | null
  closesAt: string | null
  closedAt: string | null
  /** The [투표 결과] post written when it closed. */
  resultsPostId: number | null
  /** Fans' votes still to arrive: the page keeps looking while there are some. */
  pending: number
}

export interface BoardPage {
  boardId: string
  posts: PostSummary[]
  page: number
  pages: number
  total: number
}

export interface CommentView {
  id: number
  parentId: number | null
  author: AuthorView
  body: string
  up: number
  down: number
  myVote: -1 | 0 | 1
  best: boolean
  shownAt: string
  mine: boolean
  /** Numbers in it that weren't in the facts its writer was given (only you see the marks). */
  flags: string[]
}

export interface PostView extends PostSummary {
  body: string
  myVote: -1 | 0 | 1
  gameId: number | null
  /** In order, replies right after the comment they answer. */
  thread: CommentView[]
  /** The top comments by upvotes, at or above the BEST threshold. */
  best: CommentView[]
  /** Comments still to appear (they trickle in). */
  pending: number
  /** A writer is queued or busy on this post (replies to you): more comments are coming. */
  writing: boolean
  mine: boolean
  poll: PollView | null
  /** This is a poll's [투표 결과] post: the post the poll is on. */
  resultsOf: number | null
  /** Numbers in its title or body that weren't in the facts its writer was given (only you see the marks). */
  flags: string[]
}

export interface RefreshResult {
  /** Posts and comments that appeared with this refresh. */
  revealed: number
  /** Written and waiting for later refreshes. */
  waiting: number
  /** A chatter job was queued to refill the buffer. */
  refilling: boolean
  /** Today's chatter budget is used up: only views and votes move. */
  budgetSpent: boolean
}

export interface CommunityStatus {
  personas: number
  waiting: number
  /** Story jobs queued or running. */
  writing: number
  chatterToday: number
  chatterBudget: number
  /** False while Claude Code isn't ready: nothing new gets written (refresh still moves views and votes). */
  aiReady: boolean
}

export interface WritePostInput {
  boardId: string
  title: string
  body: string
  /** A live game thread: fans react to each score update you post. */
  gameId?: number
  /** A poll on the post: 2–6 different options; a blank question takes the title. */
  poll?: PollInput
}

export interface PollInput {
  question: string
  options: string[]
}

export interface WriteCommentInput {
  postId: number
  parentId?: number
  body: string
}

export interface NewsInput {
  text: string
}

