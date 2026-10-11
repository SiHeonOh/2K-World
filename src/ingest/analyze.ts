import { idSchema, type LeagueConfig, type RatingColumn } from '@shared/config/schema'
import {
  DEFAULT_IMPORT_OPTIONS,
  importMappingSchema,
  type ColumnMapping,
  type FieldKind,
  type FieldTarget,
  type ImportMapping,
  type InferredKind,
  type SheetAnalysis,
  type SourceColumn,
} from '@shared/import'
import { cellText, columnLetter, type Cell, type SheetTable } from './workbook'

const GRADE_RE = /^[A-F][+\-−]?$/i

export function isGradeText(text: string): boolean {
  return GRADE_RE.test(text.trim())
}

const PLAIN_NUMBER_RE = /^[-+]?\d+(\.\d+)?$/
const GROUPED_NUMBER_RE = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/

/** Numbers and numeric text; a comma only as a thousands separator (`1,234`, never `87,5`). */
export function toNumber(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell !== 'string') return null
  const s = cell.trim()
  if (PLAIN_NUMBER_RE.test(s)) return Number(s)
  if (GROUPED_NUMBER_RE.test(s)) return Number(s.replace(/,/g, ''))
  return null
}

/** The first of the top rows that looks like headers: 2+ text cells, with data below it. */
export function detectHeaderRow(rows: Cell[][]): number {
  const limit = Math.min(rows.length, 30)
  for (let r = 0; r < limit; r++) {
    const row = rows[r] ?? []
    const texts = row.filter((c) => typeof c === 'string' && c.trim() !== '' && toNumber(c) === null).length
    const next = rows.slice(r + 1, r + 4).some((nr) => nr.some((c) => cellText(c) !== ''))
    if (texts >= 2 && next) return r + 1
  }
  return 1
}

/** Lists the columns under `headerRow` (1-based) with samples and a guessed type. */
export function analyzeColumns(rows: Cell[][], headerRow: number): { columns: SourceColumn[]; dataRows: number } {
  const header = rows[headerRow - 1] ?? []
  const body = rows.slice(headerRow)
  let width = header.length
  for (const r of body) if (r.length > width) width = r.length
  const columns: SourceColumn[] = []
  for (let c = 0; c < width; c++) {
    const values = body.map((r) => cellText(r[c])).filter((v) => v !== '')
    const headerText = cellText(header[c])
    if (headerText === '' && values.length === 0) continue
    columns.push({
      index: c,
      letter: columnLetter(c),
      header: headerText,
      samples: [...new Set(values)].slice(0, 4),
      filled: values.length,
      inferred: inferKind(body.map((r) => r[c] ?? null)),
    })
  }
  const dataRows = body.filter((r) => r.some((c) => cellText(c) !== '')).length
  return { columns, dataRows }
}

function inferKind(cells: Cell[]): InferredKind {
  const filled = cells.filter((c) => cellText(c) !== '')
  if (filled.length === 0) return 'empty'
  // Tolerate a few stray cells (a note typed in the wrong column).
  const share = (pred: (c: Cell) => boolean) => filled.filter(pred).length / filled.length
  if (share((c) => toNumber(c) !== null) >= 0.95) return 'number'
  if (share((c) => typeof c === 'string' && isGradeText(c)) >= 0.95) return 'grade'
  return 'text'
}

// ── Guessing a mapping ───────────────────────────────────────────────────

const SYNONYMS: Record<Exclude<FieldKind, 'ignore' | 'rating'>, string[]> = {
  team: ['team', 'teams', 'school', 'club', '팀', '학교', '소속', '팀명', '학교명'],
  division: ['division', 'div', '디비전', '지구', '지역', '권역'],
  conference: ['conference', 'conf', '컨퍼런스', '콘퍼런스'],
  name: ['name', 'player', 'player name', 'full name', '이름', '선수', '선수명', '성명'],
  slot: ['position', 'pos', 'slot', 'role', '포지션', '슬롯', '역할'],
  height: ['height', 'ht', '키', '신장'],
  nicknames: ['nickname', 'nicknames', 'alias', '별명', '별칭', '애칭'],
  notes: ['notes', 'note', 'memo', 'comment', 'comments', '메모', '비고', '특이사항', '노트'],
}

const OVERALL_SYNONYMS = ['ovr', 'overall', 'ovrl', 'ovrl rating', 'overall rating', 'rating', '오버롤', '종합', '종합 능력치']

export const normalizeHeader = (s: string) =>
  s.normalize('NFC').toLowerCase().replace(/[\s_.]+/g, ' ').trim()

/** A readable column id from a header: lower case, dashes, Korean kept. */
export function slugify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** A new column's id: the header's slug, or `col-<letter>` when that isn't a usable id. */
export function columnIdFor(header: string, letter: string): string {
  const slug = slugify(header)
  return slug !== '' && idSchema.safeParse(slug).success ? slug : `col-${letter.toLowerCase()}`
}

export function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** Header signature: a saved mapping is reused only for a sheet with the same headers in the same places. */
export function headerSignature(columns: Pick<SourceColumn, 'index' | 'header'>[]): string {
  return columns
    .filter((c) => c.header !== '')
    .map((c) => `${c.index}:${normalizeHeader(c.header)}`)
    .join('|')
}

export function suggestMapping(
  sheet: SheetTable,
  options: { headerRow?: number; base?: LeagueConfig; saved?: ImportMapping[] } = {},
): SheetAnalysis {
  const headerRow = options.headerRow ?? detectHeaderRow(sheet.rows)
  const { columns, dataRows } = analyzeColumns(sheet.rows, headerRow)
  const base = options.base

  const signature = headerSignature(columns)
  const saved = (options.saved ?? []).find(
    (m) => m.sheet === sheet.name && m.headerRow === headerRow && headerSignature(m.columns) === signature,
  )
  if (saved) {
    const checked = importMappingSchema.safeParse(saved)
    if (checked.success) {
      const suggested = { ...checked.data, columns: matchTemplateColumns(checked.data.columns, base) }
      return { sheet: sheet.name, headerRow, columns, dataRows, suggested, fromSaved: true }
    }
  }

  const baseColumns = base?.ratings.columns ?? []
  const overallId = base?.ratings.overallColumnId ?? null
  // Ids a new column must avoid, and template columns already given to a sheet column.
  const takenIds = new Set(baseColumns.map((c) => c.id))
  const claimed = new Set<string>()
  const used = new Set<string>()

  const mapping: ColumnMapping[] = columns.map((col) => {
    const target = guessTarget(col)
    return { index: col.index, header: col.header, target }
  })

  function guessTarget(col: SourceColumn): FieldTarget {
    const h = normalizeHeader(col.header)
    if (h === '') return { kind: 'ignore' }
    for (const [kind, words] of Object.entries(SYNONYMS) as [keyof typeof SYNONYMS, string[]][]) {
      if (words.includes(h) && !used.has(kind)) {
        used.add(kind)
        return { kind } as FieldTarget
      }
    }
    // A template column, unless this column clearly holds the other kind (grades vs numbers).
    const kind = col.inferred === 'number' || col.inferred === 'grade' ? col.inferred : null
    const existing = findTemplateColumn(baseColumns, overallId, h, kind, claimed)
    if (existing) {
      claimed.add(existing.id)
      return { kind: 'rating', columnId: existing.id, ratingKind: existing.kind }
    }
    if (kind === null) return { kind: 'ignore' }
    if (OVERALL_SYNONYMS.includes(h) && kind === 'number' && !takenIds.has('ovr')) {
      return { kind: 'rating', columnId: uniqueId('ovr', takenIds), ratingKind: 'number' }
    }
    return { kind: 'rating', columnId: uniqueId(columnIdFor(col.header, col.letter), takenIds), ratingKind: kind }
  }

  return {
    sheet: sheet.name,
    headerRow,
    columns,
    dataRows,
    suggested: {
      sheet: sheet.name,
      headerRow,
      columns: mapping,
      options: structuredClone(DEFAULT_IMPORT_OPTIONS),
    },
    fromSaved: false,
  }
}

/**
 * The template column a sheet column named `h` should feed: same name, else
 * the overall column for an OVR-like header. Only an unclaimed column of the
 * same kind counts (`kind` null: either kind, for an empty or mixed column).
 */
function findTemplateColumn(
  baseColumns: RatingColumn[],
  overallId: string | null,
  h: string,
  kind: 'number' | 'grade' | null,
  claimed: Set<string>,
): RatingColumn | undefined {
  const fits = (c: RatingColumn) => !claimed.has(c.id) && (kind === null || c.kind === kind)
  const byName = baseColumns.find((c) => fits(c) && normalizeHeader(c.name) === h)
  if (byName) return byName
  if (!OVERALL_SYNONYMS.includes(h) || kind === 'grade') return undefined
  return baseColumns.find((c) => c.id === overallId && c.kind === 'number' && fits(c))
}

/**
 * Points a saved mapping's rating columns at the current template's columns
 * (same name and kind), so a mapping saved for another league still reuses
 * this template's ids. Other columns keep their id unless it's now taken or
 * names a template column of the other kind.
 */
export function matchTemplateColumns(columns: ColumnMapping[], base: LeagueConfig | undefined): ColumnMapping[] {
  const baseColumns = base?.ratings.columns ?? []
  const overallId = base?.ratings.overallColumnId ?? null
  const claimed = new Set<string>()
  const matched = columns.map((c) => {
    if (c.target.kind !== 'rating') return null
    const existing = findTemplateColumn(baseColumns, overallId, normalizeHeader(c.header), c.target.ratingKind, claimed)
    if (existing) claimed.add(existing.id)
    return existing?.id ?? null
  })
  const taken = new Set([...baseColumns.map((c) => c.id), ...claimed])
  const kept = new Set(claimed)
  return columns.map((c, i) => {
    const t = c.target
    if (t.kind !== 'rating') return c
    const id = matched[i]
    if (id) return { ...c, target: { ...t, columnId: id } }
    const template = baseColumns.find((b) => b.id === t.columnId)
    if (!kept.has(t.columnId) && (!template || template.kind === t.ratingKind)) {
      kept.add(t.columnId)
      taken.add(t.columnId)
      return c
    }
    const fresh = uniqueId(t.columnId, taken)
    kept.add(fresh)
    return { ...c, target: { ...t, columnId: fresh } }
  })
}
