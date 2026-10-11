import { defaultConfig } from '@shared/config/defaults'
import type { ImportIssue, ImportMapping, ImportSummary, SheetAnalysis, WorkbookSummary } from '@shared/import'
import type { FolderInspection } from '@shared/league'
import type { LeagueSetup, SetupIssue, SetupSection, Team } from '@shared/setup'

export const STEPS = ['start', 'league', 'import', 'structure', 'roster', 'season', 'awards', 'rules', 'gm', 'review'] as const
export type StepId = (typeof STEPS)[number]

/** Which setup sections each step edits, for the error dots in the stepper. */
export const STEP_SECTIONS: Record<StepId, SetupSection[]> = {
  start: [],
  league: ['league'],
  import: [],
  structure: ['structure', 'teams'],
  roster: ['roster', 'ratings', 'players'],
  season: ['season'],
  awards: ['awards'],
  rules: ['trades', 'draft'],
  gm: ['gm'],
  review: [],
}

export interface WizardState {
  source: { kind: 'blank' } | { kind: 'template'; id: string; name: string }
  slug: string
  /** True once the folder name was typed by hand; until then it follows the league name. */
  slugTouched: boolean
  setup: LeagueSetup
  /** Teams from the template, matched by name when a sheet is imported. */
  baseTeams: Team[] | undefined
  workbook: WorkbookSummary | null
  analysis: SheetAnalysis | null
  mapping: ImportMapping | null
  /** The column matching the chosen template carries, offered first on import. */
  templateMapping: ImportMapping | null
  /** The last import's result, and the file it came from. */
  imported: { path: string; summary: ImportSummary; issues: ImportIssue[] } | null
  /** The mapping that produced `imported`; sent with the new league. */
  importedMapping: ImportMapping | null
  saveTemplate: { enabled: boolean; name: string; includePlayers: boolean }
}

export function initialState(slug = ''): WizardState {
  return {
    source: { kind: 'blank' },
    slug,
    slugTouched: slug !== '',
    setup: { config: defaultConfig(), teams: [], players: [] },
    baseTeams: undefined,
    workbook: null,
    analysis: null,
    mapping: null,
    templateMapping: null,
    imported: null,
    importedMapping: null,
    saveTemplate: { enabled: true, name: '', includePlayers: false },
  }
}

/** True when the file, sheet, header row or columns changed since the last import. */
export function importIsStale(state: WizardState): boolean {
  if (!state.imported) return false
  return state.workbook?.path !== state.imported.path || JSON.stringify(state.mapping) !== JSON.stringify(state.importedMapping)
}

export type Edit = (change: (draft: WizardState) => void) => void

export interface StepProps {
  state: WizardState
  edit: Edit
  issues: SetupIssue[]
  folder: FolderInspection | null
}
