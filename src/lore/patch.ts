import { GM_TRAITS, MEDIA_STYLES, NEGOTIATION_STYLES, PHILOSOPHIES, PLAYER_TRAITS, RELATIONSHIP_TYPES, VISIBILITIES, type LoreRelationship } from '@shared/lore'
import { cleanLoreText, cutText, MAX_TEXT } from '@shared/secretText'
import type { LoreCurrent, LorePatch, RevealStale } from '@shared/suggestions'
import type { LoreEditable } from './edit'
import { loreSchemaOf, type LoreKind } from './parse'

// Shared with 제안함, so its previews clean and cut text exactly the way approving does.
export { cleanLoreText, cutText, findExcerpt, MAX_TEXT } from '@shared/secretText'

/**
 * Lore patches: what an approved suggestion changes in a file's form data.
 * Pure functions; src/main/suggestions.ts writes the result through the lore
 * editor's merge, so anything else in the file stays as it is.
 */

export type PatchKind = Exclude<LoreKind, 'world'>

const FANS = ['size', 'temperament', 'pride'] as const

const level = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : null)
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v.trim()) ? (v.trim() as T) : null)
const nfc = (s: string) => s.normalize('NFC').trim()
const name = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s && s.length <= max ? s : null
}

/** Keeps only what fits this kind of file, with every value checked and clamped; null when nothing's left. */
export function sanitizePatch(kind: PatchKind, patch: unknown): LorePatch | null {
  if (typeof patch !== 'object' || patch === null) return null
  const p = patch as Record<string, unknown>
  const out: LorePatch = {}
  const traitList = kind === 'player' ? PLAYER_TRAITS : kind === 'gm' ? GM_TRAITS : []
  if (traitList.length && typeof p.traits === 'object' && p.traits !== null) {
    const traits: Record<string, number> = {}
    for (const t of traitList) {
      const v = level((p.traits as Record<string, unknown>)[t])
      if (v !== null) traits[t] = v
    }
    if (Object.keys(traits).length) out.traits = traits
  }
  if (kind === 'player') {
    const media = oneOf(MEDIA_STYLES, p.media)
    if (media) out.media = media
    if (Array.isArray(p.nicknames)) {
      const nicks = [...new Set(p.nicknames.map((n) => name(n, 30)).filter((n): n is string => n !== null))].slice(0, 5)
      if (nicks.length) out.nicknames = nicks
    }
  }
  if (kind === 'gm') {
    const n = name(p.name, 30)
    if (n) out.name = n
    const philosophy = oneOf(PHILOSOPHIES, p.philosophy)
    if (philosophy) out.philosophy = philosophy
    const negotiation = oneOf(NEGOTIATION_STYLES, p.negotiation)
    if (negotiation) out.negotiation = negotiation
  }
  if (kind === 'team') {
    if (typeof p.fans === 'object' && p.fans !== null) {
      const fans: LorePatch['fans'] = {}
      for (const k of FANS) {
        const v = level((p.fans as Record<string, unknown>)[k])
        if (v !== null) fans[k] = v
      }
      if (Object.keys(fans).length) out.fans = fans
    }
    if (Array.isArray(p.rivals)) {
      const rivals = [...new Set(p.rivals.map((r) => name(r, 40)).filter((r): r is string => r !== null))].slice(0, 5)
      if (rivals.length) out.rivals = rivals
    }
  }
  if (kind !== 'team' && Array.isArray(p.relationships)) {
    const seen = new Set<string>()
    const rels: LoreRelationship[] = []
    for (const r of p.relationships.slice(0, 10)) {
      if (typeof r !== 'object' || r === null) continue
      const x = r as Record<string, unknown>
      const who = name(x.with, 60)
      const type = oneOf(RELATIONSHIP_TYPES, x.type)
      if (!who || !type || seen.has(nfc(who))) continue
      seen.add(nfc(who))
      rels.push({ with: who, type, strength: level(x.strength) ?? 3, visibility: oneOf(VISIBILITIES, x.visibility) ?? 'public' })
    }
    if (rels.length) out.relationships = rels
  }
  for (const k of ['public', 'rumor'] as const) {
    const text = cleanLoreText(p[k])
    if (text) out[k] = text
  }
  return Object.keys(out).length ? out : null
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const VISIBILITY_RANK: Record<string, number> = { public: 0, rumor: 1, secret: 2 }
/** The less public of two visibilities. */
export const stricter = (a: unknown, b: LoreRelationship['visibility']): LoreRelationship['visibility'] =>
  (VISIBILITY_RANK[String(a)] ?? 0) > VISIBILITY_RANK[b]! ? (a as LoreRelationship['visibility']) : b

/** The text a section has after approval: added at its end, or filling it when it's empty. */
export const appendText = (current: string, add: string) => (current.trim() === '' ? add : `${current.replace(/\s+$/, '')}\n\n${add}`)

/**
 * The form data after a patch: settings take the patch's values (a
 * relationship replaces the one with the same person, keeping any keys the
 * app doesn't know; rivals are added), text goes at the end of its section.
 * Nicknames aren't in the file; they go on the roster.
 */
export function applyPatch(base: LoreEditable, patch: LorePatch): LoreEditable {
  const next = copy(base)
  const s = next.settings as Record<string, unknown>
  if (patch.traits) s.traits = { ...((s.traits as object) ?? {}), ...patch.traits }
  for (const k of ['media', 'name', 'philosophy', 'negotiation'] as const) if (patch[k] !== undefined) s[k] = patch[k]
  if (patch.fans) s.fans = { ...((s.fans as object) ?? {}), ...patch.fans }
  if (patch.rivals) {
    const rivals = [...((s.rivals as string[]) ?? [])]
    for (const r of patch.rivals) if (!rivals.some((x) => nfc(x) === nfc(r))) rivals.push(r)
    s.rivals = rivals
  }
  if (patch.relationships) {
    const rels = [...((s.relationships as Record<string, unknown>[]) ?? [])]
    for (const r of patch.relationships) {
      // Only a card you edited reaches here with someone the file already relates to (see fitToFile).
      const at = rels.findIndex((x) => typeof x.with === 'string' && nfc(x.with) === nfc(r.with))
      if (at >= 0) rels[at] = { ...rels[at], type: r.type, strength: r.strength, visibility: r.visibility }
      else rels.push({ ...r })
    }
    s.relationships = rels
  }
  if (patch.public) next.sections.public = appendText(next.sections.public, patch.public)
  if (patch.rumor) next.sections.rumor = appendText(next.sections.rumor, patch.rumor)
  return next
}

/** The settings a file of this kind reads as when nothing's set (a missing file's starting point). */
export function defaultEditable(kind: PatchKind, id: string): LoreEditable {
  const settings = loreSchemaOf(kind).parse(kind === 'gm' ? { id, team: id } : { id }) as Record<string, unknown>
  return { settings, sections: { public: '', rumor: '', secret: '' } }
}

/**
 * What the file (or the defaults, when there's no file) holds for the fields
 * a patch touches. 비밀 only with `secret` (a reveal card still waiting, whose
 * preview needs it).
 */
export function currentOf(kind: PatchKind, entry: LoreEditable | null, patch: LorePatch, nicknames: string[], secret = false): LoreCurrent {
  const e = entry ?? defaultEditable(kind, 'x')
  const s = e.settings as Record<string, unknown>
  const out: LoreCurrent = { exists: entry !== null }
  if (patch.traits) out.traits = { ...(s.traits as Record<string, number>) }
  if (patch.media !== undefined) out.media = s.media as string
  if (patch.name !== undefined) out.name = (s.name as string | null) ?? null
  if (patch.philosophy !== undefined) out.philosophy = s.philosophy as string
  if (patch.negotiation !== undefined) out.negotiation = s.negotiation as string
  if (patch.fans) out.fans = { ...(s.fans as Record<'size' | 'temperament' | 'pride', number>) }
  if (patch.rivals) out.rivals = [...((s.rivals as string[]) ?? [])]
  if (patch.relationships) out.relationships = copy((s.relationships as LoreRelationship[]) ?? [])
  // A reveal can be sent to either section when you edit it, so it shows both.
  if (patch.public !== undefined || patch.fromSecret !== undefined) out.public = e.sections.public
  if (patch.rumor !== undefined || patch.fromSecret !== undefined) out.rumor = e.sections.rumor
  // And 비밀 as it is now, so the card can show exactly what stays there.
  if (secret && patch.fromSecret !== undefined) out.secret = e.sections.secret
  if (patch.nicknames) out.nicknames = [...nicknames]
  return out
}

// ── Secret reveals ───────────────────────────────────────────────────────

/**
 * A reveal card as you edited it: your wording and where it goes (공개 or
 * 소문), and what you leave in 비밀 in place of the card's text
 * (`keepSecret`; left out, nothing stays), while what leaves 비밀 stays the
 * card's own. Nothing is shortened: new text longer than MAX_TEXT and the
 * secret's own length is refused ('too-long'), never cut, and so is what you
 * keep ('keep-too-long'). A secret relationship keeps its kind and strength;
 * only how known it is changes, never back to secret (that's turning the
 * card down). Null when nothing's left to apply.
 */
export function revealEdit(card: LorePatch, edited: unknown): LorePatch | 'too-long' | 'keep-too-long' | null {
  if (typeof edited !== 'object' || edited === null) return null
  const e = edited as Record<string, unknown>
  if (card.fromSecret !== undefined) {
    const max = Math.max(MAX_TEXT, card.fromSecret.length)
    const pub = cleanLoreText(e.public, Infinity)
    const text = pub || cleanLoreText(e.rumor, Infinity)
    if (!text) return null
    const keep = cleanLoreText(e.keepSecret, Infinity)
    if (text.length > max) return 'too-long'
    if (keep.length > max) return 'keep-too-long'
    return { fromSecret: card.fromSecret, ...(pub ? { public: text } : { rumor: text }), ...(keep ? { keepSecret: keep } : {}) }
  }
  const rel = card.relationships?.[0]
  if (!rel || !Array.isArray(e.relationships)) return null
  const mine = e.relationships.find((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof r.with === 'string' && nfc(r.with) === nfc(rel.with))
  const visibility = mine?.visibility === 'public' || mine?.visibility === 'rumor' ? mine.visibility : null
  return visibility ? { relationships: [{ ...rel, visibility }] } : null
}

/**
 * A reveal fitted to the file as it is now (read just before writing):
 * - text: it leaves 비밀 (or gives way to what you chose to keep there) and
 *   goes at the end of 공개 or 소문. Only when it's no longer in 비밀 does
 *   finding it already in 공개/소문 count as done (a retry after a crash);
 *   otherwise it's stale ('secret-gone'). What you kept may hold the card's
 *   text (or be it): when 비밀 holds what you kept and 공개/소문 already ends
 *   with the text, that's done too, so a retry adds neither again.
 * - a secret relationship: the tie with that person *of that kind* that's
 *   still secret becomes known (another tie with the same person is never
 *   touched). One already where the card says counts as done; one gone or
 *   made known some other way by hand is stale. `tie` is the file's own tie
 *   as it is after, for the event.
 */
export function fitReveal(base: LoreEditable, patch: LorePatch): { next: LoreEditable; tie?: LoreRelationship } | { stale: RevealStale } {
  const next = copy(base)
  if (patch.fromSecret !== undefined) {
    const to = patch.public !== undefined ? 'public' : 'rumor'
    const text = patch[to]
    if (!text) return { stale: 'nothing' }
    const holds = (section: string, s: string) => section.normalize('NFC').includes(s.normalize('NFC'))
    const cut = cutText(base.sections.secret, patch.fromSecret, patch.keepSecret)
    if (cut === null) return holds(base.sections[to], text) ? { next } : { stale: 'secret-gone' }
    const keep = patch.keepSecret?.trim()
    const last = base.sections[to].normalize('NFC').trimEnd()
    const ends = last === text.normalize('NFC') || last.endsWith(`\n${text.normalize('NFC')}`)
    if (keep && holds(base.sections.secret, keep) && ends) return { next }
    next.sections.secret = cut
    next.sections[to] = appendText(next.sections[to], text)
    return { next }
  }
  const rel = patch.relationships?.[0]
  if (!rel) return { stale: 'nothing' }
  const rels = [...((next.settings.relationships as Record<string, unknown>[] | undefined) ?? [])]
  const same = (x: Record<string, unknown>) => typeof x.with === 'string' && nfc(x.with) === nfc(rel.with) && x.type === rel.type
  const tieOf = (x: Record<string, unknown>) => ({ with: x.with, type: x.type, strength: x.strength, visibility: x.visibility }) as LoreRelationship
  const at = rels.findIndex((x) => same(x) && x.visibility === 'secret')
  if (at < 0) {
    const done = rels.find((x) => same(x) && x.visibility === rel.visibility)
    if (done) return { next, tie: tieOf(done) }
    return { stale: rels.some(same) ? 'tie-not-secret' : 'tie-gone' }
  }
  rels[at] = { ...rels[at], visibility: rel.visibility }
  next.settings.relationships = rels
  return { next, tie: tieOf(rels[at]!) }
}

// ── Blank parts (what a draft may fill) ──────────────────────────────────

/** The parts of a file a draft can fill; a part counts as blank while it's still as the template left it. */
export type DraftPart = 'traits' | 'relationships' | 'persona' | 'fans' | 'public' | 'rumor'

const allThree = (v: unknown, keys: readonly string[]) => keys.every((k) => ((v as Record<string, unknown>) ?? {})[k] === 3)

export function blankParts(kind: PatchKind, entry: LoreEditable | null): DraftPart[] {
  if (!entry) return kind === 'player' ? ['traits', 'relationships', 'public', 'rumor'] : kind === 'gm' ? ['persona', 'public', 'rumor'] : ['fans', 'public', 'rumor']
  const s = entry.settings as Record<string, unknown>
  const parts: DraftPart[] = []
  if (kind === 'player') {
    if (allThree(s.traits, PLAYER_TRAITS) && s.media === 'normal') parts.push('traits')
    if (((s.relationships as unknown[]) ?? []).length === 0) parts.push('relationships')
  } else if (kind === 'gm') {
    if (s.name === null && allThree(s.traits, GM_TRAITS) && s.philosophy === 'balanced' && s.negotiation === 'fair') parts.push('persona')
  } else if (allThree(s.fans, FANS) && ((s.rivals as unknown[]) ?? []).length === 0) parts.push('fans')
  if (entry.sections.public.trim() === '') parts.push('public')
  if (entry.sections.rumor.trim() === '') parts.push('rumor')
  return parts
}

const PART_FIELDS: Record<DraftPart, (keyof LorePatch)[]> = {
  traits: ['traits', 'media'],
  relationships: ['relationships'],
  persona: ['name', 'philosophy', 'traits', 'negotiation'],
  fans: ['fans', 'rivals'],
  public: ['public'],
  rumor: ['rumor'],
}

/** Only the fields of the parts given (a bulk draft fills blanks and leaves what you wrote alone). */
export function restrictPatch(patch: LorePatch, parts: DraftPart[]): LorePatch | null {
  const keep = new Set(parts.flatMap((p) => PART_FIELDS[p]))
  const out = Object.fromEntries(Object.entries(patch).filter(([k]) => keep.has(k as keyof LorePatch))) as LorePatch
  return Object.keys(out).length ? out : null
}

const sameRel = (a: Record<string, unknown>, b: LoreRelationship) => a.type === b.type && a.strength === b.strength && a.visibility === b.visibility
const relWith = (base: LoreEditable, who: string) =>
  ((base.settings.relationships as Record<string, unknown>[] | undefined) ?? []).find((x) => typeof x.with === 'string' && nfc(x.with) === nfc(who))

/** Whether the file already holds what a patch would put into one part (a retry after a crash). */
function partApplied(base: LoreEditable, patch: LorePatch, part: DraftPart): boolean {
  const s = base.settings as Record<string, unknown>
  const has = (key: 'traits' | 'fans', values: Record<string, number> | undefined) => Object.entries(values ?? {}).every(([k, v]) => (s[key] as Record<string, number> | undefined)?.[k] === v)
  const scalar = (k: 'media' | 'name' | 'philosophy' | 'negotiation') => patch[k] === undefined || s[k] === patch[k]
  switch (part) {
    case 'public':
    case 'rumor':
      return Boolean(patch[part]) && base.sections[part].includes(patch[part]!)
    case 'traits':
      return has('traits', patch.traits) && scalar('media')
    case 'persona':
      return has('traits', patch.traits) && scalar('name') && scalar('philosophy') && scalar('negotiation')
    case 'fans':
      return has('fans', patch.fans) && (patch.rivals ?? []).every((r) => ((s.rivals as string[]) ?? []).some((x) => nfc(x) === nfc(r)))
    case 'relationships':
      return (patch.relationships ?? []).every((r) => {
        const x = relWith(base, r.with)
        return x !== undefined && sameRel(x, r)
      })
  }
}

/**
 * A card approved as you saw it, fitted to the file as it is now (read just
 * before writing):
 * - a bulk draft (`parts`) fills only parts still blank;
 * - a trait card (`from`) applies only from the value it was suggested against;
 * - a relationship with someone the file already relates to is never changed
 *   (only a card you edit can change one).
 * Changes the file already holds count as fitting, so a retry after a crash
 * goes through. `partial` (a batch): what doesn't fit is left out; otherwise
 * anything that doesn't fit makes the whole card stale, and you decide.
 */
export function fitToFile(
  kind: PatchKind,
  base: LoreEditable,
  patch: LorePatch,
  opts: { parts?: DraftPart[]; from?: number; partial: boolean },
): { patch: LorePatch } | { stale: string } {
  let out: LorePatch = { ...patch }
  let dropped = false
  if (opts.parts) {
    const blank = blankParts(kind, base)
    const keep = opts.parts.filter((p) => blank.includes(p) || partApplied(base, out, p))
    const fitted = restrictPatch(out, keep) ?? {}
    if (Object.keys(fitted).length < Object.keys(out).length) dropped = true
    out = fitted
  }
  if (opts.from !== undefined && out.traits) {
    const now = (base.settings.traits as Record<string, number> | undefined) ?? {}
    const traits = Object.fromEntries(Object.entries(out.traits).filter(([k, v]) => (now[k] ?? 3) === opts.from || now[k] === v))
    if (Object.keys(traits).length < Object.keys(out.traits).length) dropped = true
    if (Object.keys(traits).length) out.traits = traits
    else delete out.traits
  }
  if (out.relationships) {
    const rels = out.relationships.filter((r) => {
      const x = relWith(base, r.with)
      return x === undefined || sameRel(x, r)
    })
    if (rels.length < out.relationships.length) dropped = true
    if (rels.length) out.relationships = rels
    else delete out.relationships
  }
  if (Object.keys(out).length === 0) return { stale: 'nothing fits' }
  if (dropped && !opts.partial) return { stale: 'part of it no longer fits' }
  return { patch: out }
}

/** Whether there's more to fill than 소문 and relationships (neither is worth a draft on its own: most written files have none). */
export const worthDrafting = (parts: DraftPart[]) => parts.some((p) => p !== 'rumor' && p !== 'relationships')
