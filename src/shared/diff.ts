/**
 * Text diffs for the wiki's 비교 view: lines first (Myers' algorithm), then
 * the words inside a changed line, so a rewrite shows which words moved.
 * Pure and shared: the main process builds diffs, the edit-war code finds
 * what an edit changed.
 */

export type DiffOp = 'same' | 'del' | 'add'

/** Above this many changes a diff stops looking for the shortest script and calls it all replaced. */
const MAX_LINE_CHANGES = 2000
const MAX_WORD_CHANGES = 400

/**
 * The shortest edit script from `a` to `b`: one op per element kept,
 * deleted (from a) or added (from b), in order. Past `maxD` changes it gives
 * up and returns everything deleted, then everything added.
 */
export function diffSeq<T>(a: readonly T[], b: readonly T[], maxD = MAX_LINE_CHANGES): DiffOp[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const same = (n: number): DiffOp[] => Array<DiffOp>(n).fill('same')
  return [...same(start), ...myers(a.slice(start, endA), b.slice(start, endB), maxD), ...same(a.length - endA)]
}

function myers<T>(a: readonly T[], b: readonly T[], maxD: number): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return Array<DiffOp>(m).fill('add')
  if (m === 0) return Array<DiffOp>(n).fill('del')
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // v after each step d, for k in -d..d only (so memory grows with the changes, not the text).
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) found = d
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return [...Array<DiffOp>(n).fill('del'), ...Array<DiffOp>(m).fill('add')]
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!
    const at = (k: number) => prev[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) {
      ops.push('same')
      x--
      y--
    }
    ops.push(down ? 'add' : 'del')
    if (down) y--
    else x--
  }
  while (x > 0 && y > 0) {
    ops.push('same')
    x--
    y--
  }
  return ops.reverse()
}

/** A run of text in a changed line; `changed` marks the words that differ from the line it replaced. */
export interface DiffPiece {
  text: string
  changed: boolean
}

export type DiffRow =
  | { kind: DiffOp; /** Line numbers, from 1, in the older and newer text. */ old: number | null; new: number | null; pieces: DiffPiece[] }
  | { kind: 'skip'; lines: number }

export interface TextDiff {
  rows: DiffRow[]
  added: number
  removed: number
}

/** Words for the inline diff: digits, letters (Hangul included), spaces, and any other single character. */
const tokens = (line: string): string[] => line.match(/\d+|[A-Za-zㄱ-ㆎ가-힣]+|\s+|./gsu) ?? []

/** The two lines' pieces, or null when they share too little for word marks to help. */
function inline(before: string, after: string): [DiffPiece[], DiffPiece[]] | null {
  const a = tokens(before)
  const b = tokens(after)
  const ops = diffSeq(a, b, MAX_WORD_CHANGES)
  const left: DiffPiece[] = []
  const right: DiffPiece[] = []
  const push = (into: DiffPiece[], text: string, changed: boolean) => {
    const last = into.at(-1)
    if (last && last.changed === changed) last.text += text
    else into.push({ text, changed })
  }
  let i = 0
  let j = 0
  let kept = 0
  for (const op of ops) {
    if (op === 'same') {
      kept += a[i]!.length
      push(left, a[i++]!, false)
      push(right, b[j++]!, false)
    } else if (op === 'del') push(left, a[i++]!, true)
    else push(right, b[j++]!, true)
  }
  // Mostly rewritten: marking nearly every word says less than the line's own colour.
  const longest = Math.max(before.length, after.length)
  if (longest > 0 && kept / longest < 0.4) return null
  return [left, right]
}

const whole = (text: string): DiffPiece[] => [{ text, changed: false }]

/**
 * A line diff of two texts, with `context` unchanged lines kept around each
 * change and longer unchanged stretches folded into 'skip' rows. Removed
 * and added lines that pair up (the n-th removed with the n-th added of one
 * change) get word marks.
 */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')
  const ops = diffSeq(a, b)
  const all: Extract<DiffRow, { kind: DiffOp }>[] = []
  let i = 0
  let j = 0
  let k = 0
  let added = 0
  let removed = 0
  while (k < ops.length) {
    if (ops[k] === 'same') {
      all.push({ kind: 'same', old: i + 1, new: j + 1, pieces: whole(a[i]!) })
      i++
      j++
      k++
      continue
    }
    // One change: its removed lines, then its added ones, paired in order.
    const dels: number[] = []
    const adds: number[] = []
    while (k < ops.length && ops[k] !== 'same') {
      if (ops[k] === 'del') dels.push(i++)
      else adds.push(j++)
      k++
    }
    removed += dels.length
    added += adds.length
    const marks = dels.map((d, n) => (n < adds.length ? inline(a[d]!, b[adds[n]!]!) : null))
    dels.forEach((d, n) => all.push({ kind: 'del', old: d + 1, new: null, pieces: marks[n]?.[0] ?? whole(a[d]!) }))
    adds.forEach((d, n) => all.push({ kind: 'add', old: null, new: d + 1, pieces: marks[n]?.[1] ?? whole(b[d]!) }))
  }
  // Keep the lines near a change; fold the rest.
  const near = all.map(() => false)
  all.forEach((r, n) => {
    if (r.kind === 'same') return
    for (let x = Math.max(0, n - context); x <= Math.min(all.length - 1, n + context); x++) near[x] = true
  })
  const rows: DiffRow[] = []
  for (let n = 0; n < all.length; n++) {
    if (near[n]) {
      rows.push(all[n]!)
      continue
    }
    let end = n
    while (end + 1 < all.length && !near[end + 1]) end++
    // Folding one line hides as much as it saves.
    if (end === n) rows.push(all[n]!)
    else rows.push({ kind: 'skip', lines: end - n + 1 })
    n = end
  }
  return { rows, added, removed }
}
