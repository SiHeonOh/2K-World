import { Document, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml'
import { ATX, parseLoreFile, SETEXT, sectionOf, type LoreKind, type LoreSections } from './parse'

/**
 * Edits a lore file the way a careful person would by hand: only the values
 * that changed are rewritten, in place, so comments, alignment, hint lines,
 * line endings and everything else in the file stay exactly as they were.
 * Every edit is checked by reading the result back; if a value can't be
 * patched in place, the settings block is rewritten as a whole (still
 * correct, just reformatted). Prose with comments in it is never rewritten.
 */

type Path = (string | number)[]
type Settings = Record<string, unknown>
export type SectionKey = keyof LoreSections

/** What the editor shows and sends back: the settings (as the parser reads them) and the three sections. */
export interface LoreEditable {
  settings: Settings
  sections: LoreSections
}

/** Settings the editor may change, per kind; `id` never changes. */
export const EDITABLE_FIELDS: Record<LoreKind, Path[]> = {
  player: [
    ...['ego', 'usage', 'competitiveness', 'loyalty', 'temperament', 'professionalism', 'ambition'].map((t) => ['traits', t]),
    ['media'],
    ['relationships'],
    ['hooks'],
    ['canon'],
  ],
  team: [['colors'], ['fans', 'size'], ['fans', 'temperament'], ['fans', 'pride'], ['rivals'], ['canon']],
  gm: [
    ['name'],
    ['philosophy'],
    ...['risk', 'patience', 'loyalty', 'star_chasing', 'defense_first', 'regional_pride', 'ego'].map((t) => ['traits', t]),
    ['negotiation'],
    ['relationships'],
    ['canon'],
  ],
  world: [['type'], ['date'], ['involves'], ['canon']],
}

const SECTION_KEYS: SectionKey[] = ['public', 'rumor', 'secret']
const SECTION_HEADINGS: Record<SectionKey, string> = { public: '공개', rumor: '소문', secret: '비밀' }
/** Maps inside list items written in flow style, as the templates show them: `mood: { stability: -30 }`. */
const FLOW_KEYS = new Set(['mood'])

export type LoreEditErrorCode = 'no-settings' | 'invalid' | 'split-section' | 'heading-in-text' | 'comments-in-section' | 'unverified'

export class LoreEditError extends Error {
  constructor(
    readonly code: LoreEditErrorCode,
    readonly detail = '',
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
  }
}

// ── Small helpers ────────────────────────────────────────────────────────

/** Plain data only: undefined keys dropped, so `{ rival: undefined }` equals `{}`. */
const plain = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]))
  const ka = Object.keys(a).filter((k) => (a as Settings)[k] !== undefined)
  const kb = Object.keys(b).filter((k) => (b as Settings)[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => sameValue((a as Settings)[k], (b as Settings)[k]))
}

const isRecord = (v: unknown): v is Settings => typeof v === 'object' && v !== null && !Array.isArray(v)

function getAt(obj: unknown, path: Path): unknown {
  let v = obj
  for (const k of path) v = v === null || typeof v !== 'object' ? undefined : (v as Record<string | number, unknown>)[k]
  return v
}

function setAt(obj: Settings, path: Path, value: unknown): void {
  let v = obj as Record<string | number, unknown>
  for (const k of path.slice(0, -1)) {
    if (v[k] === null || typeof v[k] !== 'object') v[k] = {}
    v = v[k] as Record<string | number, unknown>
  }
  v[path.at(-1)!] = value
}

export const pathLabel = (path: Path) => path.join('.')

/** The file around its settings block, so it can be put back together byte for byte. */
interface FileParts {
  bom: string
  open: string
  yaml: string
  close: string
  body: string
  eol: string
}

function splitFile(text: string): FileParts {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  // The same block the parser reads (FRONTMATTER in parse.ts), with the delimiters kept.
  const m = text.slice(bom.length).match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/)
  if (!m) throw new LoreEditError('no-settings')
  return { bom, open: m[1]!, yaml: m[2]!, close: m[3]!, body: m[4]!, eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

const joinFile = (p: FileParts) => p.bom + p.open + p.yaml + p.close + p.body

// ── The settings block ───────────────────────────────────────────────────

const lineStart = (src: string, at: number) => src.lastIndexOf('\n', at - 1) + 1
const lineEnd = (src: string, at: number) => {
  const i = src.indexOf('\n', at)
  return i < 0 ? src.length : src[i - 1] === '\r' ? i - 1 : i
}
const column = (src: string, at: number) => at - lineStart(src, at)

/** A single-line value as YAML writes it (quoted only when it has to be). */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return String(value)
  return new Document(value.replace(/\s*\r?\n\s*/g, ' ')).toString({ lineWidth: 0 }).replace(/\r?\n$/, '')
}

function yamlNode(value: unknown, flow: boolean): Document {
  const doc = new Document(plain(value))
  const visit = (n: unknown, key: unknown) => {
    if (isMap(n)) {
      if (FLOW_KEYS.has(String(key))) n.flow = true
      for (const p of n.items) visit(p.value, isScalar(p.key) ? p.key.value : p.key)
    } else if (isSeq(n)) for (const x of n.items) visit(x, null)
  }
  visit(doc.contents, null)
  if (flow && (isMap(doc.contents) || isSeq(doc.contents))) doc.contents.flow = true
  return doc
}

/** Block lines for a list or map, every line but the first indented (the caller places the first). */
function blockText(value: unknown, indent: number, eol: string): string {
  const lines = yamlNode(value, false).toString({ lineWidth: 0, indent: 2 }).replace(/\r?\n$/, '').split(/\r?\n/)
  return lines.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l)).join(eol)
}

const flowText = (value: unknown) => yamlNode(value, true).toString({ lineWidth: 0 }).replace(/\r?\n$/, '')

function splice(src: string, from: number, to: number, text: string): string {
  return src.slice(0, from) + text + src.slice(to)
}

/** A key with a value, as new lines under a block map at `indent`. */
function newEntryText(key: string | number, value: unknown, indent: number, eol: string): string {
  const pad = ' '.repeat(indent)
  if (value === null || typeof value !== 'object') return `${pad}${key}: ${scalarText(value)}`.trimEnd()
  if (Array.isArray(value) && value.length === 0) return `${pad}${key}: []`
  return `${pad}${key}:${eol}${pad}  ${blockText(value, indent + 2, eol)}`
}

function parseYaml(src: string) {
  const doc = parseDocument(src)
  if (doc.errors.length > 0) throw new LoreEditError('invalid', doc.errors[0]!.message)
  return doc
}

/** The key node of `path`'s last step, for where a value hangs. */
function keyStart(doc: Document, path: Path): number | undefined {
  const parent = (path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents) as Node
  const pair = isMap(parent) ? parent.items.find((p) => isScalar(p.key) && p.key.value === path.at(-1)) : undefined
  return (pair?.key as Node | undefined)?.range?.[0]
}

/** Sets one value in the YAML text, touching nothing else. Throws when the shape is one it doesn't patch in place. */
function setOne(src: string, path: Path, value: unknown, eol: string): string {
  const doc = parseYaml(src)
  const node = doc.getIn(path, true) as Node | undefined
  const isScalarValue = value === null || typeof value !== 'object'

  if (node && node.range) {
    const [r0, r1] = node.range
    if (isScalarValue) {
      if (!isScalar(node)) throw new LoreEditError('unverified', `not a single value: ${pathLabel(path)}`)
      let text = scalarText(value)
      // `key:` with nothing after it: the value needs its space, and a comment after needs one too.
      if (text !== '' && /:$/.test(src.slice(lineStart(src, r0), r0))) text = ` ${text}`
      if (text !== '' && src[r1] === '#') text = `${text} `
      return splice(src, r0, r1, text)
    }
    const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0
    if ((isSeq(node) || isMap(node)) && node.flow) return splice(src, r0, r1, flowText(value))
    if (isSeq(node) || isMap(node)) {
      if (empty) return splice(src, lineStart(src, r0), r1, '')
      const keepNewline = /\r?\n$/.test(src.slice(r0, r1))
      return splice(src, r0, r1, blockText(value, column(src, r0), eol) + (keepNewline ? eol : ''))
    }
    if (isScalar(node) && node.value === null) {
      if (empty) return src
      // Under `key:` (and its comment), before any commented-out examples below it.
      const keyAt = keyStart(doc, path)
      if (keyAt === undefined) throw new LoreEditError('unverified', `no key for ${pathLabel(path)}`)
      const indent = column(src, keyAt) + 2
      const at = lineEnd(src, r0)
      return splice(src, at, at, eol + ' '.repeat(indent) + blockText(value, indent, eol))
    }
    throw new LoreEditError('unverified', `can't patch ${pathLabel(path)}`)
  }

  // Missing: add it under the deepest map that exists, creating the maps in between.
  let depth = path.length - 1
  while (depth > 0 && !isMap(doc.getIn(path.slice(0, depth), true))) depth--
  const host = (depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true)) as Node | null
  if (!isMap(host) || !host.range) throw new LoreEditError('unverified', `no map for ${pathLabel(path)}`)
  let nested: unknown = value
  for (const k of path.slice(depth + 1).reverse()) nested = { [k]: nested }
  const key = path[depth]!
  if (host.flow) {
    const updated = { ...(host.toJSON() as Settings), [key]: nested }
    return splice(src, host.range[0], host.range[1], flowText(updated))
  }
  const indent = host.items.length > 0 ? column(src, (host.items[0]!.key as Node).range![0]) : depth * 2
  const entry = newEntryText(key, nested, indent, eol)
  // A new top-level key goes at the very end (after any trailing comments); a nested one after its map's last line.
  const at = depth === 0 ? src.length : host.range[1]
  return src[at - 1] === '\n' || at === 0 ? splice(src, at, at, entry + eol) : splice(src, at, at, eol + entry)
}

/** The block list at `path` (null when it's flow style or not a list): its item nodes. */
function blockItems(doc: Document, path: Path): Node[] | null {
  const node = doc.getIn(path, true) as Node | undefined
  return isSeq(node) && !node.flow && node.range ? (node.items as Node[]) : null
}

/** Where the comment lines right above `at`'s line begin (or that line itself, when there are none). */
function commentsAbove(src: string, at: number, floor: number): number {
  let start = lineStart(src, at)
  while (start > floor) {
    const prev = lineStart(src, start - 1)
    if (!/^\s*#/.test(src.slice(prev, start))) break
    start = prev
  }
  return start
}

/**
 * Removes list items `from`..`to` (exclusive) of a block list, with their
 * lines and the comments right above them; the next item's comments stay.
 */
function removeItems(src: string, path: Path, from: number, to: number): string {
  const doc = parseYaml(src)
  const items = blockItems(doc, path)
  const seq = doc.getIn(path, true) as Node
  if (!items || !items[from]?.range) throw new LoreEditError('unverified', `can't remove from ${pathLabel(path)}`)
  const previous = from > 0 ? lineStart(src, items[from - 1]!.range![1] - 1) : 0
  const start = commentsAbove(src, items[from]!.range![0], previous)
  const end = to < items.length ? commentsAbove(src, items[to]!.range![0], start) : seq.range![1]
  return splice(src, start, end, '')
}

/** Adds items after the last one of a block list, with their dashes in its column. */
function appendItems(src: string, path: Path, values: unknown[], eol: string): string {
  const doc = parseYaml(src)
  const items = blockItems(doc, path)
  const seq = doc.getIn(path, true) as Node
  if (!items || items.length === 0) throw new LoreEditError('unverified', `can't append to ${pathLabel(path)}`)
  const first = items[0]!.range![0]
  const dash = src.lastIndexOf('-', first)
  const indent = dash >= lineStart(src, first) ? column(src, dash) : Math.max(0, column(src, first) - 2)
  const text = ' '.repeat(indent) + blockText(values, indent, eol)
  const at = seq.range![1]
  return src[at - 1] === '\n' ? splice(src, at, at, text + eol) : splice(src, at, at, eol + text)
}

/** Takes one key out of a map, with its lines; a list item's first key (on the dash's line) rewrites that item instead. */
function deleteKey(src: string, path: Path, eol: string): string {
  const doc = parseYaml(src)
  const parentPath = path.slice(0, -1)
  const parent = doc.getIn(parentPath, true) as Node | undefined
  if (!isMap(parent) || !parent.range) throw new LoreEditError('unverified', `no map for ${pathLabel(path)}`)
  const at = parent.items.findIndex((p) => isScalar(p.key) && p.key.value === path.at(-1))
  if (at < 0) return src
  const remaining = parent.toJSON() as Settings
  delete remaining[String(path.at(-1))]
  if (parent.flow) return splice(src, parent.range[0], parent.range[1], flowText(remaining))
  const keyAt = (parent.items[at]!.key as Node).range![0]
  if (at === 0 && /-\s*$/.test(src.slice(lineStart(src, keyAt), keyAt))) return setOne(src, parentPath, remaining, eol)
  const start = lineStart(src, keyAt)
  const end = at + 1 < parent.items.length ? lineStart(src, (parent.items[at + 1]!.key as Node).range![0]) : parent.range[1]
  return splice(src, start, end, '')
}

type Op = (src: string) => string

/** A list item's identity: who a relationship is with, when a hook fires, or the value itself; repeats are numbered. */
function identities(list: unknown[]): string[] {
  const seen = new Map<string, number>()
  return list.map((v) => {
    const k = (isRecord(v) ? String(v.with ?? v.when ?? JSON.stringify(v)) : String(v)).normalize('NFC').trim()
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return `${k}#${n}`
  })
}

/** Changed keys of a map, in place (nested maps too); removed keys come out with their lines. */
function recordOps(path: Path, c: Settings, n: Settings, eol: string): Op[] {
  const ops: Op[] = []
  for (const k of Object.keys(c)) if (c[k] !== undefined && n[k] === undefined) ops.push((src) => deleteKey(src, [...path, k], eol))
  for (const k of Object.keys(n)) {
    if (n[k] === undefined || sameValue(c[k], n[k])) continue
    const ck = c[k]
    const nk = n[k]
    if (isRecord(ck) && isRecord(nk) && Object.keys(nk).length > 0) ops.push(...recordOps([...path, k], ck, nk, eol))
    else ops.push((src) => setOne(src, [...path, k], nk, eol))
  }
  return ops
}

function itemOps(path: Path, c: unknown, n: unknown, eol: string): Op[] {
  if (sameValue(c, n)) return []
  if (isRecord(c) && isRecord(n)) return recordOps(path, c, n, eol)
  return [(src) => setOne(src, path, n, eol)]
}

/**
 * The smallest edits that turn one list into another. Same length: each
 * item is edited in place. Otherwise items are matched by identity, so
 * removing one takes out just its lines, the others keep theirs (and their
 * comments), and new ones go after the last.
 */
function listOps(path: Path, current: unknown[], next: unknown[], eol: string): Op[] {
  const set = (p: Path, v: unknown): Op => (src) => setOne(src, p, v, eol)
  if (current.length === 0 || next.length === 0) return [set(path, next)]
  if (current.length === next.length) return current.flatMap((c, i) => itemOps([...path, i], c, next[i], eol))
  const ck = identities(current)
  const match = identities(next).map((k) => ck.indexOf(k))
  const kept = match.filter((i) => i >= 0)
  const inOrder = kept.every((v, i) => i === 0 || v > kept[i - 1]!)
  const firstNew = match.findIndex((i) => i < 0)
  const newAtEnd = firstNew < 0 || match.slice(firstNew).every((i) => i < 0)
  if (!inOrder || !newAtEnd || kept.length === 0) return [set(path, next)]
  const ops: Op[] = []
  const removed = current.map((_, i) => i).filter((i) => !kept.includes(i))
  for (const i of removed.reverse()) ops.push((src) => removeItems(src, path, i, i + 1))
  kept.forEach((ci, pos) => ops.push(...itemOps([...path, pos], current[ci], next[pos], eol)))
  const added = next.slice(kept.length)
  if (added.length > 0) ops.push((src) => appendItems(src, path, added, eol))
  return ops
}

/**
 * Two people's edits to one list, item by item: what I changed, added or
 * removed applies; what they did to other items stays. The same item
 * changed differently on both sides is a conflict, unless I'm overwriting.
 */
function mergeList(base: unknown[], current: unknown[], next: unknown[], overwrite: boolean): { value: unknown[]; conflict: boolean } {
  const bk = identities(base)
  const ck = identities(current)
  const nk = identities(next)
  const at = (list: unknown[], keys: string[], k: string) => list[keys.indexOf(k)]
  const out: unknown[] = []
  let conflict = false
  ck.forEach((k, i) => {
    const c = current[i]
    if (!bk.includes(k)) return void out.push(c)
    const b = at(base, bk, k)
    if (!nk.includes(k)) {
      // I took it out; if they changed it meanwhile, that's for me to decide.
      if (!sameValue(c, b) && !overwrite) {
        conflict = true
        out.push(c)
      }
      return
    }
    const n = at(next, nk, k)
    const mine = !sameValue(n, b)
    const theirs = !sameValue(c, b)
    if (mine && theirs && !sameValue(n, c) && !overwrite) conflict = true
    out.push(mine ? n : c)
  })
  nk.forEach((k, i) => {
    if (ck.includes(k)) return
    if (bk.includes(k)) {
      // They took it out; I changed it: mine comes back only when I'm overwriting.
      if (!sameValue(next[i], at(base, bk, k))) {
        if (overwrite) out.push(next[i])
        else conflict = true
      }
      return
    }
    out.push(next[i])
  })
  return { value: out, conflict }
}

/** Every change in place, or the whole block rewritten if any of them can't be. */
function patchYaml(src: string, changes: { path: Path; value: unknown; current: unknown }[], eol: string, check: (yaml: string) => boolean): string {
  try {
    let out = src
    for (const c of changes) {
      const value = plain(c.value)
      // Block lists change item by item; a flow list ([a, b]) is short and rewritten whole, in the same style.
      const byItem = Array.isArray(value) && Array.isArray(c.current) && blockItems(parseYaml(out), c.path) !== null
      const ops = byItem ? listOps(c.path, c.current as unknown[], value as unknown[], eol) : [(s: string) => setOne(s, c.path, value, eol)]
      for (const op of ops) out = op(out)
    }
    if (check(out)) return out
  } catch (e) {
    // Only a file that was broken to begin with is an error here; a step gone wrong falls back below.
    if (e instanceof LoreEditError && e.code === 'invalid' && parseDocument(src).errors.length > 0) throw e
  }
  const doc = parseDocument(src)
  for (const c of changes) doc.setIn(c.path, doc.createNode(plain(c.value)))
  const out = doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, '').replace(/\r?\n/g, eol)
  if (!check(out)) throw new LoreEditError('unverified', 'settings')
  return out
}

// ── The prose ────────────────────────────────────────────────────────────

/** A line and the line ending after it ('' for a last line without one), so untouched lines keep theirs. */
interface Line {
  text: string
  eol: string
}

function toLines(body: string): Line[] {
  const parts = body.split(/(\r?\n)/)
  const out: Line[] = []
  for (let i = 0; i < parts.length; i += 2) out.push({ text: parts[i]!, eol: parts[i + 1] ?? '' })
  return out
}

const fromLines = (lines: Line[]) => lines.map((l) => l.text + l.eol).join('')

interface Heading {
  line: number
  /** Lines the heading takes: 1, or 2 for a setext underline. */
  size: number
  section: SectionKey | null
}

/** Each line as the parser sees it: comments taken out. */
function visibleLines(lines: string[]): string[] {
  let inComment = false
  return lines.map((raw) => {
    let out = ''
    let rest = raw
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->')
        if (end < 0) return out
        rest = rest.slice(end + 3)
        inComment = false
      } else {
        const start = rest.indexOf('<!--')
        if (start < 0) return out + rest
        out += rest.slice(0, start)
        rest = rest.slice(start + 4)
        inComment = true
      }
    }
    return out
  })
}

/** Headings as the parser sees them: comments don't count, any ATX or setext style does. */
function headingsOf(lines: string[]): Heading[] {
  const visible = visibleLines(lines)
  const out: Heading[] = []
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i]!
    const atx = line.match(ATX)
    if (atx) {
      out.push({ line: i, size: 1, section: sectionOf(atx[1] ?? '') })
      continue
    }
    const next = visible[i + 1]
    if (line.trim() !== '' && next !== undefined && SETEXT.test(next) && lines[i + 1]!.trim() === next.trim()) {
      out.push({ line: i, size: 2, section: sectionOf(line) })
      i++
    }
  }
  return out
}

/** Sections that appear under more than one heading: the editor leaves those to the raw view. */
export function splitSectionsOf(body: string): SectionKey[] {
  const counts = new Map<SectionKey, number>()
  for (const h of headingsOf(body.split(/\r?\n/))) if (h.section) counts.set(h.section, (counts.get(h.section) ?? 0) + 1)
  return SECTION_KEYS.filter((k) => (counts.get(k) ?? 0) > 1)
}

const blank = (l: Line) => l.text.trim() === ''
/** Lines that are a whole comment and nothing else. */
const commentOnly = (lines: Line[]) => lines.length > 0 && lines[0]!.text.trimStart().startsWith('<!--') && visibleLines(lines.map((l) => l.text)).every((v) => v.trim() === '')

/**
 * Replaces one section's text and nothing else: its heading, the hint
 * comments right under it and the blank lines around the text stay. A
 * section with comments inside its text is refused (they'd be lost).
 */
function patchSection(body: string, key: SectionKey, text: string, eol: string): string {
  const lines = toLines(body)
  const textLines = text === '' ? [] : text.split('\n')
  if (textLines.some((l) => ATX.test(l) || SETEXT.test(l))) throw new LoreEditError('heading-in-text', key)
  const heads = headingsOf(lines.map((l) => l.text))
  const mine = heads.filter((h) => h.section === key)
  if (mine.length > 1) throw new LoreEditError('split-section', key)
  const fresh = (t: string): Line => ({ text: t, eol })

  if (mine.length === 1) {
    const h = mine[0]!
    const start = h.line + h.size
    const next = heads.find((x) => x.line > h.line)
    const end = next ? next.line : lines.length
    // Hint comments above the text and below it (whole comment blocks, blank lines between them) stay where they are.
    let hints = start
    for (let i = start; i < end; ) {
      if (blank(lines[i]!)) {
        i++
        continue
      }
      if (!lines[i]!.text.trimStart().startsWith('<!--')) break
      let j = i
      while (j < end && !lines[j]!.text.includes('-->')) j++
      if (j >= end || !commentOnly(lines.slice(i, j + 1))) break
      hints = j + 1
      i = j + 1
    }
    let tail = end
    for (let i = end - 1; i >= hints; ) {
      if (blank(lines[i]!)) {
        i--
        continue
      }
      if (!lines[i]!.text.trimEnd().endsWith('-->')) break
      let j = i
      while (j >= hints && !lines[j]!.text.includes('<!--')) j--
      if (j < hints || !commentOnly(lines.slice(j, i + 1))) break
      tail = j
      i = j - 1
    }
    let first = hints
    while (first < tail && blank(lines[first]!)) first++
    let last = tail - 1
    while (last >= first && blank(lines[last]!)) last--
    const old = lines.slice(first, last + 1)
    if (!sameValue(visibleLines(old.map((l) => l.text)), old.map((l) => l.text))) throw new LoreEditError('comments-in-section', key)
    if (old.length > 0) {
      const replacement = textLines.map(fresh)
      if (replacement.length > 0) replacement.at(-1)!.eol = old.at(-1)!.eol
      // Emptied: the blank lines that sat between the hints and the text go too.
      const from = replacement.length === 0 ? hints : first
      lines.splice(from, last + 1 - from, ...replacement)
    } else if (textLines.length > 0) {
      const added = textLines.map(fresh)
      // A file that ends right after the heading: that line needs its ending now.
      if (hints > 0 && lines[hints - 1]!.eol === '') lines[hints - 1]!.eol = eol
      if (hints === lines.length - 1 && lines[hints]!.text === '' && lines[hints]!.eol === '') lines.splice(hints, 1, ...added)
      else {
        lines.splice(hints, 0, ...added)
        const after = lines[hints + added.length]
        if (after && !blank(after)) lines.splice(hints + added.length, 0, fresh(''))
      }
    }
  } else if (textLines.length > 0) {
    // A new heading, before the sections that come after it (공개, 소문, 비밀), or at the end.
    const later = SECTION_KEYS.slice(SECTION_KEYS.indexOf(key) + 1)
    const before = heads.find((x) => x.section !== null && later.includes(x.section))
    const block = [`## ${SECTION_HEADINGS[key]}`, ...textLines].map(fresh)
    if (before) lines.splice(before.line, 0, ...block, fresh(''))
    else {
      while (lines.length > 0 && blank(lines.at(-1)!) && lines.at(-1)!.eol === '') lines.pop()
      if (lines.length > 0) {
        if (lines.at(-1)!.eol === '') lines.at(-1)!.eol = eol
        if (!blank(lines.at(-1)!)) lines.push(fresh(''))
      }
      lines.push(...block)
    }
  }
  return fromLines(lines)
}

// ── Putting it together ──────────────────────────────────────────────────

export type EditResult = { changed: false; text: string } | { changed: true; text: string } | { conflicts: string[] }

const normalizeText = (s: string) => s.replace(/\r\n?/g, '\n').trim()

/**
 * Applies what the editor changed (from `base`, what it loaded, to `next`)
 * onto the file as it is now. Changes made elsewhere in between are kept;
 * a field both sides changed differently is a conflict and nothing is
 * written, unless `overwrite` says the editor's version wins those.
 */
export function editLore(text: string, relPath: string, base: LoreEditable, next: LoreEditable, options: { overwrite?: boolean } = {}): EditResult {
  const parts = splitFile(text)
  const current = parseLoreFile(relPath, text)
  if (!current.entry) throw new LoreEditError('invalid', current.errors[0]?.message ?? '')
  const kind = current.entry.kind
  const now: LoreEditable = { settings: current.entry.settings as Settings, sections: current.entry.sections }

  const conflicts: string[] = []
  const fieldChanges: { path: Path; value: unknown; current: unknown }[] = []
  for (const path of EDITABLE_FIELDS[kind]) {
    const b = plain(getAt(base.settings, path))
    const n = plain(getAt(next.settings, path))
    if (sameValue(b, n)) continue
    const c = plain(getAt(now.settings, path))
    if (sameValue(c, n)) continue
    if (Array.isArray(b) && Array.isArray(n) && Array.isArray(c)) {
      // Lists merge item by item: a relationship added elsewhere survives mine being edited.
      const merged = mergeList(b, c, n, options.overwrite === true)
      if (merged.conflict) conflicts.push(pathLabel(path))
      else if (!sameValue(merged.value, c)) fieldChanges.push({ path, value: merged.value, current: c })
    } else if (!sameValue(c, b) && !options.overwrite) conflicts.push(pathLabel(path))
    else fieldChanges.push({ path, value: n, current: c })
  }
  const sectionChanges: { key: SectionKey; text: string }[] = []
  for (const key of SECTION_KEYS) {
    const b = normalizeText(base.sections[key])
    const n = normalizeText(next.sections[key])
    if (b === n) continue
    const c = normalizeText(now.sections[key])
    if (c === n) continue
    if (c !== b && !options.overwrite) conflicts.push(`sections.${key}`)
    else sectionChanges.push({ key, text: n })
  }
  if (conflicts.length > 0) return { conflicts }
  if (fieldChanges.length === 0 && sectionChanges.length === 0) return { changed: false, text }

  const expected = structuredClone(now)
  for (const c of fieldChanges) setAt(expected.settings, c.path, plain(c.value))
  for (const c of sectionChanges) expected.sections[c.key] = c.text
  const settingsOf = (yaml: string) => parseLoreFile(relPath, joinFile({ ...parts, yaml }))

  if (fieldChanges.length > 0) {
    parts.yaml = patchYaml(parts.yaml, fieldChanges, parts.eol, (yaml) => {
      const e = settingsOf(yaml).entry
      return e !== null && sameValue(e.settings, expected.settings)
    })
  }
  for (const c of sectionChanges) parts.body = patchSection(parts.body, c.key, c.text, parts.eol)
  // A file that ended right at its closing `---` gets the line ending before new text.
  if (parts.body !== '' && !/\n$/.test(parts.close)) parts.close += parts.eol

  const out = joinFile(parts)
  const check = parseLoreFile(relPath, out).entry
  if (!check || !sameValue(check.settings, expected.settings)) throw new LoreEditError('unverified', 'settings')
  for (const key of SECTION_KEYS) if (check.sections[key] !== expected.sections[key]) throw new LoreEditError('unverified', `sections.${key}`)
  return { changed: true, text: out }
}
