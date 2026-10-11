import { useSyncExternalStore } from 'react'
import type { LoreEditableView } from '@shared/lore'

/**
 * Unsaved lore edits, per player, school, GM or world file (not per path, so
 * a trade moving the file doesn't orphan them). They live in memory and in
 * localStorage, so switching files, leaving the screen or closing the app
 * never loses them; a draft disappears when it's saved or thrown away.
 */
export interface LoreDraft {
  /** What the form started from (the file as it was loaded): a save merges against it. */
  base: LoreEditableView | null
  next: LoreEditableView | null
  /** Raw text being edited, and the version of the file it started from. */
  raw: { version: string; text: string } | null
  at: number
}

const STORAGE_KEY = 'twok.loreDrafts.v2'
const drafts = new Map<string, LoreDraft>()
const listeners = new Set<() => void>()
let loaded = false
let version = 0
let pending: ReturnType<typeof setTimeout> | null = null

/** Drafts belong to one league (its scope: folder and creation time), never to another with the same name. */
const keyOf = (scope: string, key: string) => `${scope}\n${key}`

/** What a draft is filed under: the player, school or GM a file is about, or the file itself. */
export const draftKeyOf = (link: { kind: string; playerId?: string; teamId?: string } | null, file: string) =>
  link?.kind === 'player' ? `player:${link.playerId}` : link?.kind === 'team' || link?.kind === 'gm' ? `${link.kind}:${link.teamId}` : `file:${file}`

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, LoreDraft>)) drafts.set(k, v)
  } catch {
    // Storage unavailable or damaged: drafts just won't survive a restart.
  }
}

function flush(): void {
  if (pending) clearTimeout(pending)
  pending = null
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)))
  } catch {
    // Out of space or unavailable: the draft stays in memory for this session.
  }
}

function persist(): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(flush, 250)
}

// Closing the app mid-debounce must neither lose the last keystrokes nor bring back a draft just saved.
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => pending && flush())

function changed(): void {
  version++
  persist()
  for (const l of listeners) l()
}

export function getDraft(scope: string, draftKey: string): LoreDraft | null {
  load()
  return drafts.get(keyOf(scope, draftKey)) ?? null
}

export function setDraft(scope: string, draftKey: string, draft: LoreDraft | null): void {
  load()
  const key = keyOf(scope, draftKey)
  if (draft === null) {
    if (!drafts.has(key)) return
    drafts.delete(key)
  } else drafts.set(key, draft)
  changed()
}

/** Draft keys in this league with unsaved edits; re-renders when that changes. */
export function useDraftKeys(scope: string): Set<string> {
  load()
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
  const prefix = `${scope}\n`
  return new Set([...drafts.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))
}
