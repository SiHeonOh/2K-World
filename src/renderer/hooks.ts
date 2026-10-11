import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushTopic } from '@shared/api'

export type Load<T> =
  | { state: 'loading' }
  | { state: 'error'; error: unknown }
  | { state: 'ready'; value: T }

export interface LoadOptions {
  /** Keep showing the last value while refetching the same resource (same first dep); `refreshing` is set meanwhile. */
  keepPrevious?: boolean
}

/** Runs `fn` on mount and whenever `deps` change; `reload` runs it again. */
export function useLoad<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  options: LoadOptions = {},
): Load<T> & { reload: () => void; refreshing: boolean } {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  // The first dep names the resource; set while a value for it is shown.
  const shown = useRef<{ key: unknown } | null>(null)
  const keep = options.keepPrevious === true
  useEffect(() => {
    let alive = true
    const key = deps[0]
    if (keep && shown.current !== null && Object.is(shown.current.key, key)) {
      setRefreshing(true)
    } else {
      shown.current = null
      setLoad({ state: 'loading' })
      setRefreshing(false)
    }
    fnRef.current().then(
      (value) => {
        if (!alive) return
        shown.current = { key }
        setLoad({ state: 'ready', value })
        setRefreshing(false)
      },
      (error: unknown) => {
        if (!alive) return
        shown.current = null
        setLoad({ state: 'error', error })
        setRefreshing(false)
      },
    )
    return () => {
      alive = false
    }
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...load, reload, refreshing }
}

/** Deep equality for plain JSON-like data; stops at the first difference. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => sameData(x, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  return keys.length === Object.keys(rb).length && keys.every((k) => Object.hasOwn(rb, k) && sameData(ra[k], rb[k]))
}

/** Puts back `prev`'s top-level branches that `next` didn't change, so memos on them hold. */
function keepUnchanged<T>(prev: T, next: T): T {
  if (typeof prev !== 'object' || prev === null || typeof next !== 'object' || next === null || Array.isArray(next)) return next
  const before = prev as Record<string, unknown>
  const after = next as Record<string, unknown>
  let changed = Object.keys(before).length !== Object.keys(after).length
  for (const key of Object.keys(after)) {
    if (Object.hasOwn(before, key) && sameData(before[key], after[key])) after[key] = before[key]
    else changed = true
  }
  // Nothing changed at all: keep the old object so React skips the render.
  return changed ? next : prev
}

/** State edited through a mutable draft: `edit(d => { d.x = 1 })`. Unchanged top-level branches keep their identity. */
export function useDraft<T>(initial: T | (() => T)): [T, (change: (draft: T) => void) => void, (next: T) => void] {
  const [value, setValue] = useState<T>(initial)
  const edit = useCallback((change: (draft: T) => void) => {
    setValue((current) => {
      const next = structuredClone(current)
      change(next)
      return keepUnchanged(current, next)
    })
  }, [])
  return [value, edit, setValue]
}

/**
 * Calls `onChange` when the background finishes work for this league on
 * one of `topics` (a writer saved posts, say), so a screen can look again
 * at once instead of waiting for its next poll. Notes that arrive close
 * together make one call, and a steady stream still makes one every
 * `maxWaitMs`.
 */
export function usePush(slug: string, topics: readonly PushTopic[], onChange: () => void, settleMs = 400, maxWaitMs = 2000): void {
  const latest = useRef(onChange)
  latest.current = onChange
  const key = topics.join(',')
  useEffect(() => {
    // Older bridges (and tests without one) simply don't push.
    if (typeof window.twok?.onPush !== 'function') return
    const wanted = new Set(key.split(','))
    let timer: ReturnType<typeof setTimeout> | null = null
    let firstAt: number | null = null
    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = null
      firstAt = null
      latest.current()
    }
    const stop = window.twok.onPush((note) => {
      if (note.slug !== slug || !wanted.has(note.topic)) return
      firstAt ??= Date.now()
      if (Date.now() - firstAt >= maxWaitMs) return fire()
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, settleMs)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [slug, key, settleMs, maxWaitMs])
}
