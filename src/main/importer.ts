import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { LeagueConfig } from '@shared/config/schema'
import type { ImportMapping, ImportResult, SheetAnalysis, WorkbookSummary } from '@shared/import'
import type { Team } from '@shared/setup'
import { headerSignature, suggestMapping } from '@ingest/analyze'
import { importRoster } from '@ingest/roster'
import { readWorkbook, type SheetTable } from '@ingest/workbook'
import { AppError } from './errors'
import type { SettingsStore } from './settings'

export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xlsm', 'xls', 'csv']
const MAX_BYTES = 50 * 1024 * 1024

/**
 * Reads spreadsheets for the setup wizard. Only files you picked in a dialog
 * or dropped on the window can be read, so the page can't ask for any path.
 * Parsed workbooks are cached by path + mtime.
 */
export class ImportService {
  private cache = new Map<string, { mtimeMs: number; size: number; sheets: SheetTable[] }>()
  private granted = new Set<string>()

  constructor(private readonly settings: SettingsStore) {}

  /** Allows reading `path`: call only with paths from a file dialog or a real dropped File. */
  grant(path: string): void {
    // Network paths would make Windows authenticate to the remote host.
    if (path.startsWith('\\') || path.startsWith('//')) throw new AppError('invalid-input', 'network paths are not supported')
    this.granted.add(path)
  }

  open(path: string): WorkbookSummary {
    const sheets = this.sheets(path)
    return {
      path,
      fileName: basename(path),
      sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length, cols: s.rows.reduce((m, r) => Math.max(m, r.length), 0) })),
    }
  }

  analyze(
    path: string,
    sheet: string,
    headerRow: number | undefined,
    base: LeagueConfig,
    templateMapping?: ImportMapping,
  ): SheetAnalysis {
    const saved = this.settings.read().importMappings
    return suggestMapping(this.sheet(path, sheet), {
      headerRow,
      base,
      saved: templateMapping ? [templateMapping, ...saved] : saved,
    })
  }

  run(path: string, mapping: ImportMapping, base: { config: LeagueConfig; teams?: Team[] }): ImportResult {
    return importRoster(this.sheet(path, mapping.sheet), mapping, base)
  }

  remember(mapping: ImportMapping): void {
    this.settings.rememberMapping(mapping, (m) => `${m.sheet}|${m.headerRow}|${headerSignature(m.columns)}`)
  }

  private sheet(path: string, name: string): SheetTable {
    const sheet = this.sheets(path).find((s) => s.name === name)
    if (!sheet) throw new AppError('not-found', `sheet ${name} not found`)
    return sheet
  }

  private sheets(path: string): SheetTable[] {
    if (!this.granted.has(path)) throw new AppError('invalid-input', `file was not chosen: ${path}`)
    const ext = extname(path).slice(1).toLowerCase()
    if (!SPREADSHEET_EXTENSIONS.includes(ext)) throw new AppError('invalid-input', `not a spreadsheet: ${path}`)
    let stat
    try {
      stat = statSync(path)
    } catch (e) {
      throw new AppError('file-read', `can't open ${path}: ${(e as Error).message}`)
    }
    if (stat.size > MAX_BYTES) throw new AppError('file-read', `file is too large: ${path}`)
    const hit = this.cache.get(path)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.sheets
    let sheets: SheetTable[]
    try {
      sheets = readWorkbook(new Uint8Array(readFileSync(path)))
    } catch (e) {
      throw new AppError('file-read', `can't read ${path}: ${(e as Error).message}`)
    }
    this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, sheets })
    if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!)
    return sheets
  }
}
