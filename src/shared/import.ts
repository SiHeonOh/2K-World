import { z } from 'zod'
import type { LeagueSetup } from './setup'

/**
 * Spreadsheet import: which source column feeds which field. Saved after a
 * successful import (matched by header signature) and offered next time.
 */

export const fieldTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignore') }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('division') }),
  z.object({ kind: z.literal('conference') }),
  z.object({ kind: z.literal('name') }),
  z.object({ kind: z.literal('slot') }),
  z.object({ kind: z.literal('height') }),
  z.object({ kind: z.literal('nicknames') }),
  z.object({ kind: z.literal('notes') }),
  /** A rating column; `columnId` is an existing column or a new one to create. */
  z.object({
    kind: z.literal('rating'),
    columnId: z.string().min(1),
    ratingKind: z.enum(['number', 'grade']),
  }),
])

export const columnMappingSchema = z.object({
  /** 0-based column index in the sheet. */
  index: z.number().int().min(0),
  header: z.string(),
  target: fieldTargetSchema,
})

export const shortNameRuleSchema = z.object({
  /** Suffix to replace, e.g. a long school-type word. */
  from: z.string().min(1),
  to: z.string(),
})

export const importOptionsSchema = z.object({
  /** Splits the nicknames cell into separate nicknames. */
  nicknameSeparator: z.string().min(1).max(3),
  /** Applied to team names to suggest short names. */
  shortNameRules: z.array(shortNameRuleSchema),
})

export const importMappingSchema = z.object({
  sheet: z.string(),
  /** 1-based, as Excel shows it. */
  headerRow: z.number().int().min(1),
  columns: z.array(columnMappingSchema),
  options: importOptionsSchema,
})

export type FieldTarget = z.infer<typeof fieldTargetSchema>
export type FieldKind = FieldTarget['kind']
export type ColumnMapping = z.infer<typeof columnMappingSchema>
export type ImportOptions = z.infer<typeof importOptionsSchema>
export type ImportMapping = z.infer<typeof importMappingSchema>

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  nicknameSeparator: ',',
  shortNameRules: [{ from: '고등학교', to: '고' }],
}

// ── What the main process returns while you match columns ────────────────

export interface WorkbookSummary {
  path: string
  fileName: string
  sheets: { name: string; rows: number; cols: number }[]
}

export type InferredKind = 'empty' | 'number' | 'grade' | 'text'

export interface SourceColumn {
  index: number
  /** Column letter as Excel shows it (A, B, …, AA). */
  letter: string
  header: string
  samples: string[]
  filled: number
  inferred: InferredKind
}

export interface SheetAnalysis {
  sheet: string
  headerRow: number
  columns: SourceColumn[]
  dataRows: number
  /** A mapping to start from: saved earlier, or guessed from headers. */
  suggested: ImportMapping
  /** True when `suggested` came from a mapping saved earlier. */
  fromSaved: boolean
}

export type ImportIssueCode =
  | 'row-skipped'
  | 'name-trimmed'
  | 'duplicate-name'
  | 'team-two-divisions'
  | 'team-two-conferences'
  | 'unknown-grade'
  | 'not-a-number'
  | 'missing-required'
  | 'no-team-column'
  | 'no-name-column'
  | 'height-unreadable'
  /** A height Excel had made a date (6-2 → 2 June), turned back into feet and inches. */
  | 'height-from-date'
  /** Excel made a date of something typed in a text column (a name, a slot, a nickname). */
  | 'date-cell'
  | 'template-team-missing'
  | 'template-column-missing'
  | 'template-division-missing'
  | 'template-conference-missing'
  | 'duplicate-target'
  | 'division-two-conferences'
  | 'team-no-division'
  | 'value-truncated'

export interface ImportIssue {
  level: 'error' | 'warning' | 'info'
  code: ImportIssueCode
  /** 1-based sheet rows, when the issue is about rows. */
  rows: number[]
  params: Record<string, string | number>
}

export interface ImportSummary {
  teams: number
  players: number
  divisions: number
  conferences: number
  slots: number
  ratingColumns: number
}

export interface ImportResult {
  setup: LeagueSetup
  summary: ImportSummary
  issues: ImportIssue[]
}
