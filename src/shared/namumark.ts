/**
 * A namumark subset, parsed into a small tree the wiki screen renders.
 *
 * Blocks: `= h1 =` … `====== h6 ======` (`==# 제목 #==` starts folded), paragraphs,
 * ` * ` and ` 1. ` lists (indent nests), `|| a || b ||` tables (`||||a||` and a
 * `<-2>` cell attribute span columns), `> ` quotes, `----`,
 * `{{{#!folding 제목` … `}}}`, `{{{` code `}}}`, `[목차]`, `[각주]`, and app macros
 * like `[기록]` and `[인간관계]` that the screen fills from the league data.
 * Inline: `'''bold'''`, `''italic''`, `__underline__`, `~~strike~~` / `--strike--`,
 * `[[문서]]`, `[[문서|보이는 글]]`, `[[문서#s-1]]`, `[* 각주]`, `{{{#red 글}}}` /
 * `{{{#ff0000 글}}}`, `{{{+1 크게}}}`, `{{{-1 작게}}}`, `[br]`, and `[[분류:이름]]`
 * (collected, not shown inline).
 *
 * Pages are parsed in the main process when they're saved, so any input must
 * parse in about linear time without deep recursion: brackets are matched in
 * one pass per line, and markup nested deeper than a fixed limit stays text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 'u' | 's'; c: Inline[] }
  | { t: 'link'; page: string; anchor: string | null; c: Inline[] }
  | { t: 'fn'; n: number; c: Inline[] }
  | { t: 'color'; color: string; c: Inline[] }
  | { t: 'size'; step: number; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }

export type Block =
  | { t: 'h'; level: number; num: string; id: string; text: Inline[]; folded: boolean }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: { c: Inline[]; sub: Block[] }[] }
  /** `spans[r][c]` is how many columns `rows[r][c]` spans; left out when every cell spans one. */
  | { t: 'table'; rows: Inline[][][]; spans?: number[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'fold'; title: string; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'macro'; name: string; arg: string | null }

export interface Heading {
  level: number
  num: string
  id: string
  title: string
}

export interface WikiDoc {
  blocks: Block[]
  headings: Heading[]
  footnotes: { n: number; c: Inline[] }[]
  categories: string[]
  /** Pages this one links to (without anchors), in order, once each. */
  links: string[]
}

const COLORS = new Set(['red', 'blue', 'green', 'orange', 'purple', 'gray', 'grey', 'black', 'white', 'brown', 'pink', 'navy', 'gold', 'silver'])
const MACROS = new Set(['목차', 'tableofcontents', '각주', 'footnote', '기록', '역사', '정보', '최근경기', '인간관계'])

/** Inline markup nested deeper than this is left as text. */
const MAX_INLINE_DEPTH = 20
/** Quotes and `{{{#!folding` / `{{{#!wiki` blocks nested deeper than this are left as text. */
const MAX_BLOCK_DEPTH = 10
/** List items indented deeper than this many levels join the deepest list. */
const MAX_LIST_DEPTH = 10
/** Browsers cap colspan at 1000 too. */
const MAX_COLSPAN = 1000

interface Ctx {
  footnotes: { n: number; c: Inline[] }[]
  categories: string[]
  links: string[]
}

type HeadingBlock = Extract<Block, { t: 'h' }>

/** One parse's state: the caller's ctx, sets that keep its lists unique in linear time, and the headings met. */
interface State {
  ctx: Ctx
  links: Set<string>
  categories: Set<string>
  heads: HeadingBlock[]
}

const stateOf = (ctx: Ctx): State => ({ ctx, links: new Set(ctx.links), categories: new Set(ctx.categories), heads: [] })

// ── Inline ───────────────────────────────────────────────────────────────

const PAIRS: { open: string; close: string; t: 'b' | 'i' | 'u' | 's' }[] = [
  { open: "'''", close: "'''", t: 'b' },
  { open: "''", close: "''", t: 'i' },
  { open: '__', close: '__', t: 'u' },
  { open: '~~', close: '~~', t: 's' },
  { open: '--', close: '--', t: 's' },
]
const PAIR_START = new Set(PAIRS.map((p) => p.open[0]!))
const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[a-zA-Z]+)\s([\s\S]*)$/
const SIZE = /^([+-][1-5])\s([\s\S]*)$/

/**
 * Where each `open` in `text` is closed (by index of the `close`), honouring
 * nesting. One left-to-right pass with a stack, so a line full of openers costs
 * one scan instead of one scan per opener.
 */
function matchBrackets(text: string, open: string, close: string): Map<number, number> {
  const ends = new Map<number, number>()
  const stack: number[] = []
  const o = open[0]!
  const c = close[0]!
  for (let i = 0; i < text.length; ) {
    const ch = text[i]
    if (ch === o && text.startsWith(open, i)) {
      stack.push(i)
      i += open.length
    } else if (ch === c && text.startsWith(close, i)) {
      const at = stack.pop()
      if (at !== undefined) ends.set(at, i)
      i += close.length
    } else {
      i++
    }
  }
  return ends
}

export function parseInline(text: string, ctx: Ctx = { footnotes: [], categories: [], links: [] }): Inline[] {
  return inline(text, stateOf(ctx), 0)
}

function inline(text: string, st: State, depth: number): Inline[] {
  if (depth > MAX_INLINE_DEPTH) return text ? [{ t: 'text', v: text }] : []
  const out: Inline[] = []
  let i = 0
  let plainFrom = 0
  /** Ends the plain text before `i`, adds `node` (if any) and carries on at `to`. */
  const take = (node: Inline | null, to: number) => {
    if (i > plainFrom) out.push({ t: 'text', v: text.slice(plainFrom, i) })
    if (node) out.push(node)
    i = to
    plainFrom = to
  }
  // Bracket matches, worked out the first time an opener of that kind turns up.
  let links: Map<number, number> | undefined
  let notes: Map<number, number> | undefined
  let braces: Map<number, number> | undefined
  // The last lookup of each pair closer: `i` only grows, so one answer serves
  // every later lookup that starts at or before it (and "none" serves all).
  const seen = new Map<string, { from: number; at: number }>()
  const nextClose = (token: string, from: number) => {
    const last = seen.get(token)
    if (last && from >= last.from && (last.at < 0 || from <= last.at)) return last.at
    const at = text.indexOf(token, from)
    seen.set(token, { from, at })
    return at
  }
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '[') {
      // [[link]] or [[분류:…]]
      if (text[i + 1] === '[') {
        const end = (links ??= matchBrackets(text, '[[', ']]')).get(i)
        if (end !== undefined) {
          take(link(text.slice(i + 2, end), st, depth), end + 2)
          continue
        }
      }
      // [* footnote]
      if (text[i + 1] === '*') {
        const end = (notes ??= matchBrackets(text, '[', ']')).get(i)
        if (end !== undefined) {
          take(footnote(text.slice(i + 2, end), st, depth), end + 1)
          continue
        }
      }
      if (text.slice(i, i + 4).toLowerCase() === '[br]') {
        take({ t: 'br' }, i + 4)
        continue
      }
    } else if (ch === '{') {
      // {{{…}}}: colour, size, or literal code
      if (text.startsWith('{{{', i)) {
        const end = (braces ??= matchBrackets(text, '{{{', '}}}')).get(i)
        if (end !== undefined) {
          take(brace(text.slice(i + 3, end), st, depth), end + 3)
          continue
        }
      }
    } else if (PAIR_START.has(ch)) {
      const pair = PAIRS.find((p) => text.startsWith(p.open, i))
      if (pair) {
        const start = i + pair.open.length
        const end = nextClose(pair.close, start)
        if (end > start) {
          take({ t: pair.t, c: inline(text.slice(start, end), st, depth + 1) }, end + pair.close.length)
          continue
        }
      }
    }
    i++
  }
  take(null, text.length)
  return out
}

/** `inner` is what sits between `[[` and `]]`. Null for categories (collected) and empty targets. */
function link(inner: string, st: State, depth: number): Inline | null {
  const bar = inner.indexOf('|')
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
  if (/^분류\s*:/.test(target)) {
    const cat = target.replace(/^분류\s*:\s*/, '').trim()
    if (cat && !st.categories.has(cat)) {
      st.categories.add(cat)
      st.ctx.categories.push(cat)
    }
    return null
  }
  if (!target) return null
  const hash = target.indexOf('#')
  const page = (hash >= 0 ? target.slice(0, hash) : target).trim()
  const anchor = hash >= 0 ? target.slice(hash + 1).trim() || null : null
  if (page && !st.links.has(page)) {
    st.links.add(page)
    st.ctx.links.push(page)
  }
  const label = bar >= 0 ? inline(inner.slice(bar + 1), st, depth + 1) : [{ t: 'text' as const, v: target }]
  return { t: 'link', page, anchor, c: label }
}

function footnote(body: string, st: State, depth: number): Inline {
  // Take this note's number before reading its body, so notes inside it come after it.
  const note: { n: number; c: Inline[] } = { n: st.ctx.footnotes.length + 1, c: [] }
  st.ctx.footnotes.push(note)
  note.c = inline(body.replace(/^\s/, ''), st, depth + 1)
  return { t: 'fn', n: note.n, c: note.c }
}

/** `inner` is what sits between `{{{` and `}}}`. */
function brace(inner: string, st: State, depth: number): Inline {
  const color = inner.match(COLOR)
  if (color && (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(color[1]!) || COLORS.has(color[1]!.toLowerCase()))) {
    const name = color[1]!
    return { t: 'color', color: /^[0-9a-fA-F]+$/.test(name) ? `#${name}` : name.toLowerCase(), c: inline(color[2]!, st, depth + 1) }
  }
  const size = inner.match(SIZE)
  if (size) return { t: 'size', step: Number(size[1]), c: inline(size[2]!, st, depth + 1) }
  return { t: 'code', v: inner }
}

/** Plain text of inline content (for heading titles and anchors). */
export function plain(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v
        case 'br':
          return ' '
        case 'fn':
          return ''
        default:
          return plain(n.c)
      }
    })
    .join('')
}

// ── Blocks ───────────────────────────────────────────────────────────────

const LIST = /^(\s+)(\*|1\.|[aAiI]\.)\s?(.*)$/

/**
 * A heading line: the same number (1–6) of `=` on both ends around a title,
 * `==# 제목 #==` for one that starts folded; trailing spaces don't count.
 * Counted by hand: a regex here backtracks badly on long lines.
 */
function matchHeading(line: string): { level: number; title: string; folded: boolean } | null {
  if (line[0] !== '=') return null
  const s = line.trimEnd()
  let level = 0
  while (level < s.length && level <= 6 && s[level] === '=') level++
  if (level > 6) return null
  let closing = 0
  while (closing < s.length - level && closing <= 6 && s[s.length - 1 - closing] === '=') closing++
  if (closing !== level) return null
  let inner = s.slice(level, s.length - level)
  const folded = inner.length >= 2 && inner.startsWith('#') && inner.endsWith('#')
  if (folded) inner = inner.slice(1, -1)
  else if (inner.startsWith('#') || inner.endsWith('#')) return null
  const title = inner.trim()
  return title ? { level, title, folded } : null
}

export function parseWiki(source: string): WikiDoc {
  const st = stateOf({ footnotes: [], categories: [], links: [] })
  const blocks = parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'), st, 0)
  const headings = numberHeadings(st.heads)
  return { blocks, headings, footnotes: st.ctx.footnotes, categories: st.ctx.categories, links: st.ctx.links }
}

/**
 * Numbers headings the way Namuwiki does: from the shallowest level on the
 * page, with a skipped level counted as 1 (and kept at 1 for the headings
 * after it). Ids are `s-<number>` and never repeat.
 */
function numberHeadings(heads: HeadingBlock[]): Heading[] {
  let base = 6
  for (const h of heads) base = Math.min(base, h.level)
  const counters = [0, 0, 0, 0, 0, 0]
  const ids = new Set<string>()
  return heads.map((h) => {
    const at = h.level - base
    for (let k = 0; k < at; k++) if (counters[k] === 0) counters[k] = 1
    counters[at]!++
    counters.fill(0, at + 1)
    const num = counters.slice(0, at + 1).join('.')
    let id = `s-${num}`
    for (let k = 2; ids.has(id); k++) id = `s-${num}-${k}`
    ids.add(id)
    h.num = num
    h.id = id
    return { level: h.level, num, id, title: plain(h.text) }
  })
}

/** Macros that only point elsewhere (the 목차, the footnotes): never what a section has to say. */
const NAVIGATION = new Set(['목차', '각주'])

/**
 * The page as a reader sees it. A section with nothing to show is left out,
 * heading and all, as Namuwiki pages have no empty sections, and the headings
 * left are numbered again, so the 목차 has no gaps. A section has something
 * to show when it has text of its own, a macro with data (`filled`, by macro
 * name), text the app writes for it while it's empty (`auto`, by title; an
 * `[auto]` macro carrying the title goes right under its heading), or a
 * subsection with something. [목차] and [각주] don't count, and footnotes
 * whose [각주] went with an empty section show at the page's end. Editors
 * still see every section in the source.
 */
export function shownPage(doc: WikiDoc, filled: (macro: string) => boolean, auto: (title: string) => boolean = () => false): { blocks: Block[]; headings: Heading[] } {
  const blocks = doc.blocks
  // Each heading's own blocks run to the next heading; its section, to the next one at its level or above.
  const heads = blocks.flatMap((b, i) => (b.t === 'h' ? [i] : []))
  const own = (at: number) => {
    const next = heads.find((h) => h > at) ?? blocks.length
    return blocks.slice(at + 1, next)
  }
  const says = (b: Block) => b.t !== 'h' && b.t !== 'hr' && !(b.t === 'macro' && (NAVIGATION.has(b.name) || !filled(b.name)))
  const titleAt = (at: number) => plain((blocks[at] as HeadingBlock).text)
  // The text the app writes goes to the first section of each title.
  const firsts = new Set<number>()
  const titles = new Set<string>()
  for (const at of heads) {
    if (titles.has(titleAt(at))) continue
    titles.add(titleAt(at))
    firsts.add(at)
  }
  const autoAt = new Set<number>()
  const keep = new Map<number, boolean>()
  // Deepest first, so a section knows whether its subsections have something.
  for (const at of [...heads].reverse()) {
    const level = (blocks[at] as HeadingBlock).level
    const end = heads.find((x) => x > at && (blocks[x] as HeadingBlock).level <= level) ?? blocks.length
    const text = own(at).some(says)
    const fill = !text && firsts.has(at) && auto(titleAt(at))
    if (fill) autoAt.add(at)
    keep.set(at, text || fill || heads.some((x) => x > at && x < end && keep.get(x)))
  }
  const out: Block[] = []
  const shownHeads: HeadingBlock[] = []
  let hidden = false
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.t === 'h') {
      hidden = !keep.get(i)
      if (hidden) continue
      const copy: HeadingBlock = { ...b }
      shownHeads.push(copy)
      out.push(copy)
      if (autoAt.has(i)) out.push({ t: 'macro', name: 'auto', arg: plain(b.text) })
      continue
    }
    if (!hidden) out.push(b)
  }
  return { blocks: out, headings: numberHeadings(shownHeads) }
}

function parseBlocks(lines: string[], st: State, depth: number): Block[] {
  const blocks: Block[] = []
  const nest = depth < MAX_BLOCK_DEPTH
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      const c: Inline[] = []
      para.forEach((l, k) => {
        if (k > 0) c.push({ t: 'br' })
        for (const n of inline(l, st, 0)) c.push(n)
      })
      // A line that was only a category link leaves nothing to show.
      if (c.some((n) => n.t !== 'br')) blocks.push({ t: 'p', c })
    }
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    // Multi-line {{{#!folding 제목 … }}} and {{{ code }}}
    if (trimmed.startsWith('{{{') && !trimmed.slice(3).includes('}}}')) {
      const body: string[] = []
      let open = 1
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]!
        open += (l.match(/\{\{\{/g) ?? []).length
        open -= (l.match(/\}\}\}/g) ?? []).length
        if (open <= 0) {
          const before = l.slice(0, l.lastIndexOf('}}}'))
          if (before.trim()) body.push(before)
          break
        }
        body.push(l)
      }
      flushPara()
      const head = trimmed.slice(3)
      const fold = head.match(/^#!folding\s*(.*)$/)
      // Too deep to nest further: the block shows as it was written.
      if (fold && nest) blocks.push({ t: 'fold', title: fold[1]!.trim() || '[ 펼치기 · 접기 ]', c: parseBlocks(body, st, depth + 1) })
      else if (head.startsWith('#!wiki') && nest) for (const b of parseBlocks(body, st, depth + 1)) blocks.push(b)
      else blocks.push({ t: 'pre', v: [head, ...body].filter((l, k) => k > 0 || l.trim()).join('\n') })
      i = j + 1
      continue
    }
    const h = matchHeading(line)
    if (h) {
      flushPara()
      const block: HeadingBlock = { t: 'h', level: h.level, num: '', id: '', text: inline(h.title, st, 0), folded: h.folded }
      st.heads.push(block)
      blocks.push(block)
      i++
      continue
    }
    if (/^-{4,}\s*$/.test(line)) {
      flushPara()
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    const macro = trimmed.match(/^\[([^\[\]()]+)(?:\(([^)]*)\))?\]$/)
    if (macro && MACROS.has(macro[1]!.toLowerCase())) {
      flushPara()
      const name = macro[1]!.toLowerCase()
      blocks.push({ t: 'macro', name: name === 'tableofcontents' ? '목차' : name === 'footnote' ? '각주' : name, arg: macro[2] ?? null })
      i++
      continue
    }
    if (trimmed.startsWith('||')) {
      flushPara()
      const rows: Inline[][][] = []
      const spans: number[][] = []
      while (i < lines.length && lines[i]!.trim().startsWith('||')) {
        const row = tableRow(lines[i]!.trim(), st)
        rows.push(row.cells)
        spans.push(row.spans)
        i++
      }
      blocks.push(spans.some((r) => r.some((n) => n > 1)) ? { t: 'table', rows, spans } : { t: 'table', rows })
      continue
    }
    // Too deep to nest further: a quote line is just text.
    if (line.startsWith('>') && nest) {
      flushPara()
      const quoted: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quoted.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ t: 'quote', c: parseBlocks(quoted, st, depth + 1) })
      continue
    }
    if (LIST.test(line)) {
      flushPara()
      const [list, next] = parseList(lines, i, st, 1)
      blocks.push(list)
      i = next
      continue
    }
    if (!trimmed) {
      flushPara()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return blocks
}

/** One trimmed `|| a || b ||` line's cells and their column spans. */
function tableRow(line: string, st: State): { cells: Inline[][]; spans: number[] } {
  const cells: Inline[][] = []
  const spans: number[] = []
  const parts = line.replace(/^\|\|/, '').replace(/\|\|$/, '').split('||')
  // `||||a||`: each empty cell before a cell widens it by a column.
  let span = 1
  parts.forEach((part, k) => {
    if (part === '' && k < parts.length - 1) {
      span++
      return
    }
    // Leading cell attributes like `<bgcolor=#fff><-2>`: `<-N>` spans N columns, the rest are dropped.
    const attr = /\s*<([^<>]*)>/y
    let rest = 0
    for (let m = attr.exec(part); m; m = attr.exec(part)) {
      const cols = /^\s*-(\d+)\s*$/.exec(m[1]!)
      if (cols) span = Number(cols[1])
      rest = attr.lastIndex
    }
    cells.push(inline(part.slice(rest).trim(), st, 0))
    spans.push(Math.min(Math.max(span, 1), MAX_COLSPAN))
    span = 1
  })
  return { cells, spans }
}

function parseList(lines: string[], start: number, st: State, level: number): [Block, number] {
  const first = lines[start]!.match(LIST)!
  const indent = first[1]!.length
  const ordered = first[2] !== '*'
  const items: { c: Inline[]; sub: Block[] }[] = []
  let i = start
  while (i < lines.length) {
    const m = lines[i]!.match(LIST)
    if (!m) break
    const depth = m[1]!.length
    if (depth < indent) break
    if (depth > indent && items.length && level < MAX_LIST_DEPTH) {
      const [sub, next] = parseList(lines, i, st, level + 1)
      items.at(-1)!.sub.push(sub)
      i = next
      continue
    }
    items.push({ c: inline(m[3]!, st, 0), sub: [] })
    i++
  }
  return [{ t: 'list', ordered, items }, i]
}

/**
 * Sections of a source by heading, for section-level edits. Joining every
 * section's `text` gives back the source exactly (line endings included). The
 * first section, titled null, is the text before the first heading and is left
 * out when there is none.
 */
export function splitWikiSections(source: string): { title: string | null; level: number; text: string }[] {
  const out: { title: string | null; level: number; text: string }[] = [{ title: null, level: 0, text: '' }]
  const breaks = /\r\n?|\n/g
  let start = 0
  while (start < source.length) {
    const m = breaks.exec(source)
    const end = m ? m.index : source.length
    const next = m ? end + m[0].length : source.length
    const h = matchHeading(source.slice(start, end))
    const text = source.slice(start, next)
    if (h) out.push({ title: h.title, level: h.level, text })
    else out.at(-1)!.text += text
    start = next
  }
  return out[0]!.text ? out : out.slice(1)
}
