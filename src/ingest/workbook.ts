import * as XLSX from 'xlsx'

export type Cell = string | number | boolean | null

/** A cell Excel stored as a date: the calendar date it shows (the time of day dropped). */
export interface ExcelDate {
  year: number
  month: number
  day: number
}

export interface SheetTable {
  name: string
  /** rows[0] is sheet row 1 and rows[r][0] is column A, whatever the sheet's used range. */
  rows: Cell[][]
  /**
   * Cells Excel stored as dates, keyed `${row}:${col}` like `rows`. Their
   * value in `rows` is the date as Excel showed it ("2-Jun"), not the day
   * number underneath (45445). Excel turns some things typed into a cell into
   * dates on its own: a height typed 6-2 becomes 2 June.
   */
  dates?: Map<string, ExcelDate>
}

export const dateKey = (row: number, col: number) => `${row}:${col}`

/**
 * An Excel day number (1900 system) as a date, for a number that lost its
 * date format (pasted as a value). Only days from 1955 to 2118, so ordinary
 * numbers aren't taken for dates.
 */
export function excelSerialDate(value: Cell | undefined): ExcelDate | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 20000 || value > 80000) return null
  const d = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A date as Excel shows (and saves to CSV) one it made from what was typed:
 * 2-Jun, 06월 02일, 2024-06-02, 2024. 6. 2. Year-less month-first forms
 * (Jun-24) are left alone: Excel writes a month and a year that way.
 */
export function shownDate(text: string): Omit<ExcelDate, 'year'> | null {
  const s = text.trim().toLowerCase()
  let m = /^(\d{1,2})-([a-z]{3})(?:-\d{2,4})?$/.exec(s)
  if (m && MONTHS.includes(m[2]!)) return { month: MONTHS.indexOf(m[2]!) + 1, day: Number(m[1]) }
  m = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/.exec(s)
  if (m) return { month: Number(m[1]), day: Number(m[2]) }
  m = /^\d{4}\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/.exec(s)
  if (m) return { month: Number(m[1]), day: Number(m[2]) }
  return null
}

/** Reads every sheet of an .xlsx/.xls/.csv file into plain cell grids. */
export function readWorkbook(data: Uint8Array): SheetTable[] {
  const common = { cellDates: false, cellHTML: false, cellStyles: false }
  // Text files are decoded here (SheetJS assumes Latin-1) and read raw, so `6-4` or `5/11` stay text.
  // Workbooks keep their number formats (cellNF), so a date cell can be told from a number.
  const wb = isBinaryWorkbook(data)
    ? XLSX.read(data, { type: 'array', cellNF: true, ...common })
    : XLSX.read(decodeText(data), { type: 'string', raw: true, ...common })
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904)
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    if (!ws || !ws['!ref']) return { name, rows: [] }
    const range = XLSX.utils.decode_range(ws['!ref'])
    const raw = XLSX.utils.sheet_to_json<Cell[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      range: { s: { r: 0, c: 0 }, e: range.e },
    })
    const rows = raw.map((r) => r.map(normalizeCell))
    const dates = readDates(ws, rows, date1904)
    fillMergedDown(rows, ws['!merges'] ?? [], dates)
    return dates.size > 0 ? { name, rows, dates } : { name, rows }
  })
}

/** Finds the date cells (a number with a date format) and shows each as Excel did. */
function readDates(ws: XLSX.WorkSheet, rows: Cell[][], date1904: boolean): Map<string, ExcelDate> {
  const dates = new Map<string, ExcelDate>()
  for (const ref of Object.keys(ws)) {
    if (ref.startsWith('!')) continue
    const cell = ws[ref] as XLSX.CellObject
    if (cell.t !== 'n' || typeof cell.v !== 'number' || typeof cell.z !== 'string' || !XLSX.SSF.is_date(cell.z)) continue
    const { r, c } = XLSX.utils.decode_cell(ref)
    const row = rows[r]
    if (!row || r >= rows.length) continue
    const parts = XLSX.SSF.parse_date_code(cell.v, { date1904 })
    if (!parts || parts.m < 1 || parts.d < 1) continue
    dates.set(dateKey(r, c), { year: parts.y, month: parts.m, day: parts.d })
    while (row.length <= c) row.push(null)
    row[c] = normalizeCell(cell.w ?? `${parts.y}-${parts.m}-${parts.d}`)
  }
  return dates
}

/** Zip (xlsx, xlsb, ods) or OLE (xls) containers; anything else is treated as text. */
function isBinaryWorkbook(data: Uint8Array): boolean {
  if (data[0] === 0x50 && data[1] === 0x4b) return true
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return true
  if (isUtf16(data)) return false
  // A NUL byte never appears in a text spreadsheet: let SheetJS sniff the format.
  return data.subarray(0, 4096).includes(0)
}

const isUtf16 = (data: Uint8Array) => (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)

/** UTF-8 (with or without BOM), else CP949, the Korean Excel default. A BOM is dropped. */
export function decodeText(data: Uint8Array): string {
  if (isUtf16(data)) return new TextDecoder(data[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(data)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    // WHATWG 'euc-kr' is windows-949, so it covers every Hangul syllable.
    return new TextDecoder('euc-kr').decode(data)
  }
}

/**
 * A vertically merged cell (say a Team or Division column merged over the
 * team's rows) gets its value on every row it spans. Horizontal merges keep
 * the value in their first column only.
 */
function fillMergedDown(rows: Cell[][], merges: XLSX.Range[], dates: Map<string, ExcelDate>): void {
  for (const m of merges) {
    if (m.e.r <= m.s.r) continue
    const value = rows[m.s.r]?.[m.s.c] ?? null
    if (value === null) continue
    const date = dates.get(dateKey(m.s.r, m.s.c))
    for (let r = m.s.r + 1; r <= m.e.r && r < rows.length; r++) {
      const row = rows[r]!
      while (row.length <= m.s.c) row.push(null)
      if (row[m.s.c] !== null) continue
      row[m.s.c] = value
      if (date) dates.set(dateKey(r, m.s.c), date)
    }
  }
}

function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value === '' ? null : value.normalize('NFC')
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return ''
  return String(cell).trim()
}

export function columnLetter(index: number): string {
  return XLSX.utils.encode_col(index)
}
