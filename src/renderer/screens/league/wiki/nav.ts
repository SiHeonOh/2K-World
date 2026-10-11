/** The wiki screen's views, as the `v` search parameter. */
export type View = 'page' | 'edit' | 'history' | 'diff' | 'backlinks' | 'recent' | 'search' | 'talk' | 'thread' | 'talks'

/** Where the wiki goes next: a page and view, plus a revision, a search, an anchor, two revisions to compare or a thread. */
export interface Go {
  page?: string | null
  v?: View
  rev?: number
  q?: string
  anchor?: string | null
  from?: number
  to?: number
  /** A 토론 thread. */
  t?: number
}

export const stamp = (iso: string) => new Date(iso).toLocaleString('ko-KR')

/** Set while the editor or a 토론 box holds unsaved text, so leaving asks first. */
export const unsaved = { current: false }
