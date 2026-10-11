import { defaultConfig } from '@shared/config/defaults'
import { idSchema, type LeagueConfig, type RatingColumn, type Slot } from '@shared/config/schema'
import { parseHeightCm } from '@shared/height'
import type { ColumnMapping, FieldKind, ImportIssue, ImportMapping, ImportResult } from '@shared/import'
import type { Player, RatingValue, Team } from '@shared/setup'
import { isGradeText, normalizeHeader, slugify, toNumber, uniqueId } from './analyze'
import { cellText, columnLetter, dateKey, excelSerialDate, shownDate, type Cell, type SheetTable } from './workbook'

/** One data row after the mapping is applied. */
export interface ParsedRow {
  row: number
  team: string
  division: string | null
  conference: string | null
  name: string
  slot: string | null
  height: string
  nicknames: string[]
  notes: string
  /** Keyed by rating column id. Grades are normalized (e.g. "b+" → "B+"). */
  ratings: Record<string, Cell>
}

export interface ImportBase {
  config: LeagueConfig
  /** Teams from a template, matched to sheet teams by name. */
  teams?: Team[]
}

const BENCH_RE = /6th|sixth|bench|reserve|sub|벤치|식스|후보|교체|식스맨/i

/** The setup schema's text limits, applied here so one long cell is cut and flagged instead of failing the whole setup. */
const LIMITS = {
  team: 80,
  shortName: 40,
  name: 80,
  division: 80,
  conference: 80,
  slot: 80,
  rating: 80,
  height: 20,
  nickname: 60,
  nicknames: 20,
  notes: 4000,
}

/** Applies a column mapping to a sheet and builds a full league setup from it. */
export function importRoster(sheet: SheetTable, mapping: ImportMapping, base: ImportBase): ImportResult {
  const issues: ImportIssue[] = []
  const checked = checkMapping(mapping, issues)
  const rows = parseRows(sheet, checked, base.config, issues)
  const built = buildSetup(rows, checked, base, issues)
  return { ...built, issues: mergeIssues(issues) }
}

// ── Step 0: the mapping itself ───────────────────────────────────────────

/** Fields fed by one column at most; notes and nicknames join every column mapped to them. */
const SINGLE_FIELDS: FieldKind[] = ['team', 'name', 'division', 'conference', 'slot', 'height']

/**
 * Repairs what a hand-made or saved mapping can get wrong. A rating id that
 * isn't a valid id becomes `col-<letter>`. A field or rating column fed by two
 * sheet columns is an error: the first column is kept, the others ignored.
 */
export function checkMapping(mapping: ImportMapping, issues: ImportIssue[]): ImportMapping {
  const valid = (id: string) => idSchema.safeParse(id).success
  const ids = new Set(mapping.columns.flatMap((c) => (c.target.kind === 'rating' && valid(c.target.columnId) ? [c.target.columnId] : [])))
  const owners = new Map<string, ColumnMapping[]>()
  const columns = mapping.columns.map((c): ColumnMapping => {
    let target = c.target
    if (target.kind === 'rating' && !valid(target.columnId)) {
      target = { ...target, columnId: uniqueId(`col-${columnLetter(c.index).toLowerCase()}`, ids) }
    }
    if (target.kind !== 'rating' && !SINGLE_FIELDS.includes(target.kind)) return { ...c, target }
    const key = target.kind === 'rating' ? `rating:${target.columnId}` : `field:${target.kind}`
    const list = owners.get(key)
    if (list) {
      list.push(c)
      return { ...c, target: { kind: 'ignore' } }
    }
    owners.set(key, [c])
    return { ...c, target }
  })
  for (const [key, list] of owners) {
    if (list.length < 2) continue
    const [kind, target] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    issues.push({
      level: 'error',
      code: 'duplicate-target',
      rows: [],
      params: {
        target,
        kind: kind === 'rating' ? 'rating' : target,
        columns: list.map((c) => c.header || columnLetter(c.index)).join(', '),
      },
    })
  }
  return { ...mapping, columns }
}

// ── Step 1: cells → rows ─────────────────────────────────────────────────

export function parseRows(
  sheet: SheetTable,
  mapping: ImportMapping,
  config: LeagueConfig,
  issues: ImportIssue[],
): ParsedRow[] {
  const all = (kind: FieldKind) => mapping.columns.filter((c) => c.target.kind === kind).map((c) => c.index)
  const col = (kind: FieldKind) => all(kind)[0]
  const teamCol = col('team')
  const nameCol = col('name')
  if (teamCol === undefined) issues.push({ level: 'error', code: 'no-team-column', rows: [], params: {} })
  if (nameCol === undefined) issues.push({ level: 'error', code: 'no-name-column', rows: [], params: {} })
  if (teamCol === undefined || nameCol === undefined) return []

  const divisionCol = col('division')
  const conferenceCol = col('conference')
  const slotCol = col('slot')
  const heightCol = col('height')
  const nickCols = all('nicknames')
  const notesCols = all('notes')
  const ratingCols = mapping.columns.flatMap((c) => (c.target.kind === 'rating' ? [{ index: c.index, target: c.target }] : []))
  const grades = new Map(config.ratings.gradeScale.map((g) => [g.label.toUpperCase(), g.label]))
  const sep = mapping.options.nicknameSeparator
  const inchMark = heightStyle(sheet, mapping.headerRow, heightCol)
  // Text fields where a date can only be Excel's doing (notes may hold real dates).
  const textCols = [teamCol, nameCol, divisionCol, conferenceCol, slotCol, ...nickCols].filter((i): i is number => i !== undefined)

  const out: ParsedRow[] = []
  for (let r = mapping.headerRow; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r] ?? []
    const rowNo = r + 1
    if (!cells.some((c) => cellText(c) !== '')) continue
    const text = (index: number | undefined) => (index === undefined ? '' : cellText(cells[index]))
    const fitted = (value: string, max: number, field: string) => fit(value, max, field, rowNo, issues)
    const optional = (index: number | undefined, max: number, field: string) => {
      const value = text(index).replace(/\s+/g, ' ')
      return value === '' ? null : fitted(value, max, field)
    }

    const rawName = cells[nameCol]
    const team = text(teamCol)
    const name = text(nameCol).replace(/\s+/g, ' ')
    if (team === '' || name === '') {
      issues.push({ level: 'warning', code: 'row-skipped', rows: [rowNo], params: {} })
      continue
    }
    if (typeof rawName === 'string' && rawName !== name) {
      issues.push({ level: 'info', code: 'name-trimmed', rows: [rowNo], params: { name } })
    }

    const ratings: Record<string, Cell> = {}
    for (const { index, target } of ratingCols) {
      const raw = cells[index] ?? null
      const value = cellText(raw)
      if (value === '') {
        ratings[target.columnId] = null
      } else if (target.ratingKind === 'number') {
        const n = toNumber(raw)
        if (n === null) {
          issues.push({ level: 'warning', code: 'not-a-number', rows: [rowNo], params: { column: header(mapping, index), value } })
        }
        ratings[target.columnId] = n
      } else {
        const label = isGradeText(value) ? grades.get(value.replace('−', '-').toUpperCase()) : undefined
        if (label === undefined) {
          issues.push({ level: 'warning', code: 'unknown-grade', rows: [rowNo], params: { column: header(mapping, index), value } })
        }
        ratings[target.columnId] = label ?? null
      }
    }

    for (const index of textCols) {
      if (sheet.dates?.has(dateKey(r, index))) {
        issues.push({ level: 'warning', code: 'date-cell', rows: [rowNo], params: { column: header(mapping, index), value: text(index) } })
      }
    }

    let height = text(heightCol)
    if (height !== '' && parseHeightCm(height) === null) {
      // Excel makes a date of a height typed 6-2 (2 June): the month and day give it back.
      const date = heightCol === undefined ? null : (sheet.dates?.get(dateKey(r, heightCol)) ?? excelSerialDate(cells[heightCol]) ?? shownDate(height))
      const fixed = date ? heightOfDate(date.month, date.day, inchMark) : null
      if (fixed) {
        issues.push({ level: 'warning', code: 'height-from-date', rows: [rowNo], params: { value: height, height: fixed } })
        height = fixed
      } else {
        issues.push({ level: 'warning', code: 'height-unreadable', rows: [rowNo], params: { value: height } })
      }
    }

    // Every nicknames column, split; every notes column, one per line.
    const allNicknames = nickCols
      .flatMap((i) => text(i).split(sep))
      .map((s) => s.trim())
      .filter((s) => s !== '')
    let cut = allNicknames.length > LIMITS.nicknames
    const nicknames = allNicknames.slice(0, LIMITS.nicknames).map((n) => {
      if (n.length <= LIMITS.nickname) return n
      cut = true
      return clip(n, LIMITS.nickname)
    })
    if (cut) issues.push({ level: 'warning', code: 'value-truncated', rows: [rowNo], params: { field: 'nicknames' } })
    const notes = notesCols.map(text).filter((s) => s !== '').join('\n')

    out.push({
      row: rowNo,
      team: fitted(team, LIMITS.team, 'team'),
      division: optional(divisionCol, LIMITS.division, 'division'),
      conference: optional(conferenceCol, LIMITS.conference, 'conference'),
      name: fitted(name, LIMITS.name, 'name'),
      slot: optional(slotCol, LIMITS.slot, 'slot'),
      height: fitted(height, LIMITS.height, 'height'),
      nicknames,
      notes: fitted(notes, LIMITS.notes, 'notes'),
      ratings,
    })
  }
  return out
}

const header = (mapping: ImportMapping, index: number) =>
  mapping.columns.find((c) => c.index === index)?.header ?? String(index)

/** Whether the column's own heights end with an inch mark (6'4") or not (6'4), so a mended one matches. */
function heightStyle(sheet: SheetTable, headerRow: number, col: number | undefined): boolean {
  if (col === undefined) return true
  let marked = 0
  let bare = 0
  for (let r = headerRow; r < sheet.rows.length; r++) {
    const s = cellText(sheet.rows[r]?.[col])
    if (/^\d\s*['’′]\s*\d{1,2}\s*["”″]$/.test(s)) marked++
    else if (/^\d\s*['’′]\s*\d{1,2}$/.test(s)) bare++
  }
  return bare === 0 || marked >= bare
}

/**
 * A height Excel turned into a date: month and day are feet and inches (6-2
 * became 2 June). A day-first Excel swaps them (6 February), so the other
 * order is tried when the first isn't a height. Null when neither is.
 */
export function heightOfDate(month: number, day: number, inchMark = true): string | null {
  const fits = (feet: number, inches: number) => feet >= 4 && feet <= 8 && inches >= 0 && inches <= 11
  const [feet, inches] = fits(month, day) ? [month, day] : fits(day, month) ? [day, month] : [null, null]
  return feet === null ? null : `${feet}'${inches}${inchMark ? '"' : ''}`
}

/** Cuts text to `max` UTF-16 units without splitting a surrogate pair, and drops trailing spaces. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max
  return value.slice(0, end).trimEnd()
}

/** `clip`, flagging the row when something was cut. */
function fit(value: string, max: number, field: string, row: number, issues: ImportIssue[]): string {
  if (value.length <= max) return value
  issues.push({ level: 'warning', code: 'value-truncated', rows: [row], params: { field } })
  return clip(value, max)
}

// ── Step 2: rows → setup ─────────────────────────────────────────────────

const sameName = (a: string, b: string) => a.normalize('NFC').trim() === b.normalize('NFC').trim()

export function shortName(name: string, rules: ImportMapping['options']['shortNameRules']): string {
  for (const rule of rules) {
    if (name.endsWith(rule.from) && name.length > rule.from.length) return name.slice(0, -rule.from.length) + rule.to
  }
  return name
}

/** t01…t36, p001…p216: sortable ids sized to the count. */
function pad(prefix: string, n: number, total: number, minWidth: number): string {
  return prefix + String(n).padStart(Math.max(minWidth, String(total).length), '0')
}

/** The untouched default config is no template: none of its parts count as "missing" from a sheet. */
const DEFAULTS = defaultConfig()
const sameItems = (a: { id: string; name: string }[], b: { id: string; name: string }[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.name === b[i]!.name)

export function buildSetup(
  rows: ParsedRow[],
  mapping: ImportMapping,
  base: ImportBase,
  issues: ImportIssue[],
): Omit<ImportResult, 'issues'> {
  // A deep copy, and everything below comes from it: the result never shares objects with `base`.
  const config = structuredClone(base.config)
  const baseTeams = base.teams ?? []
  const baseStructure = base.config.structure
  // A mapped column only replaces the base structure when it actually has values.
  const hasDivisionCol = rows.some((r) => r.division !== null)
  const hasConferenceCol = rows.some((r) => r.conference !== null)
  const hasSlotCol = rows.some((r) => r.slot !== null)

  // Teams, in sheet order, each with the first division/conference its rows name (blank cells don't count).
  const teamOrder: string[] = []
  const teamDivision = new Map<string, string>()
  const teamConference = new Map<string, string>()
  const teamRows = new Map<string, number[]>()
  const note = (map: Map<string, string>, r: ParsedRow, value: string | null, code: 'team-two-divisions' | 'team-two-conferences') => {
    if (value === null) return
    const known = map.get(r.team)
    if (known === undefined) map.set(r.team, value)
    else if (known !== value) issues.push({ level: 'error', code, rows: [r.row], params: { team: r.team } })
  }
  for (const r of rows) {
    if (!teamRows.has(r.team)) {
      teamOrder.push(r.team)
      teamRows.set(r.team, [])
    }
    teamRows.get(r.team)!.push(r.row)
    note(teamDivision, r, r.division, 'team-two-divisions')
    note(teamConference, r, r.conference, 'team-two-conferences')
  }

  // Conferences. Only base ids whose name is still in the sheet keep their meaning.
  let keptConferences = new Set(baseStructure.conferences.map((c) => c.id))
  if (hasConferenceCol) {
    const names = unique(rows.flatMap((r) => (r.conference === null ? [] : [r.conference])))
    const existing = names.map((name) => baseStructure.conferences.find((c) => sameName(c.name, name)))
    keptConferences = new Set(existing.flatMap((c) => (c ? [c.id] : [])))
    const taken = new Set(keptConferences)
    config.structure.conferences = names.map((name, i) => ({ id: existing[i]?.id ?? uniqueId(`c${i + 1}`, taken), name }))
    const lost = baseStructure.conferences.filter((c) => !keptConferences.has(c.id))
    if (lost.length > 0) {
      issues.push({
        level: 'info',
        code: 'template-conference-missing',
        rows: [],
        params: { conferences: lost.map((c) => c.name).join(', '), count: lost.length },
      })
    }
  }
  const conferenceId = (name: string | undefined) =>
    name === undefined ? null : (config.structure.conferences.find((c) => sameName(c.name, name))?.id ?? null)

  // Divisions
  let keptDivisions = new Set(baseStructure.divisions.map((d) => d.id))
  if (hasDivisionCol) {
    const names = unique(rows.flatMap((r) => (r.division === null ? [] : [r.division])))
    const matches = names.map((name) => baseStructure.divisions.find((d) => sameName(d.name, name)))
    keptDivisions = new Set(matches.flatMap((d) => (d ? [d.id] : [])))
    const taken = new Set(keptDivisions)
    config.structure.divisions = names.map((name, i) => ({
      id: matches[i]?.id ?? uniqueId(`d${i + 1}`, taken),
      name,
      conferenceId: matches[i]?.conferenceId ?? null,
    }))
    const lost = baseStructure.divisions.filter((d) => !keptDivisions.has(d.id))
    if (lost.length > 0 && !sameItems(baseStructure.divisions, DEFAULTS.structure.divisions)) {
      issues.push({
        level: 'info',
        code: 'template-division-missing',
        rows: [],
        params: { divisions: lost.map((d) => d.name).join(', '), count: lost.length },
      })
    }
  }
  const fallbackDivision = config.structure.divisions[0]!
  const divisionId = (team: string, matched: Team | undefined): string => {
    const name = teamDivision.get(team)
    if (name !== undefined) return config.structure.divisions.find((d) => sameName(d.name, name))?.id ?? fallbackDivision.id
    if (matched && keptDivisions.has(matched.divisionId)) return matched.divisionId
    if (hasDivisionCol) {
      issues.push({
        level: 'warning',
        code: 'team-no-division',
        rows: [...teamRows.get(team)!],
        params: { team, division: fallbackDivision.name },
      })
    }
    return fallbackDivision.id
  }

  // Teams
  const teamIds = new Set<string>(baseTeams.map((t) => t.id))
  const teams: Team[] = teamOrder.map((name, i) => {
    const matched = baseTeams.find((t) => sameName(t.name, name) || sameName(t.shortName, name))
    const firstRow = teamRows.get(name)![0]!
    return {
      id: matched?.id ?? uniqueId(pad('t', i + 1, teamOrder.length, 2), teamIds),
      name,
      shortName: matched?.shortName ?? fit(shortName(name, mapping.options.shortNameRules), LIMITS.shortName, 'shortName', firstRow, issues),
      divisionId: divisionId(name, matched),
      control: matched?.control ?? 'ai',
      colors: [...(matched?.colors ?? [])],
    }
  })
  const missing = baseTeams.filter((bt) => !teams.some((t) => t.id === bt.id))
  if (missing.length > 0) {
    issues.push({
      level: 'warning',
      code: 'template-team-missing',
      rows: [],
      params: { teams: missing.map((t) => t.shortName).join(', '), count: missing.length },
    })
  }
  const teamIdByName = new Map(teamOrder.map((name, i) => [name, teams[i]!.id]))

  // Each division's conference is the one its teams name in the sheet; two is an error.
  if (hasConferenceCol) {
    for (const d of config.structure.divisions) {
      const ids = unique(
        teamOrder.flatMap((name, i) => {
          const id = teams[i]!.divisionId === d.id ? conferenceId(teamConference.get(name)) : null
          return id === null ? [] : [id]
        }),
      )
      if (ids.length > 1) {
        const names = ids.map((id) => config.structure.conferences.find((c) => c.id === id)!.name)
        issues.push({
          level: 'error',
          code: 'division-two-conferences',
          rows: [],
          params: { division: d.name, conferences: names.join(', ') },
        })
      }
      d.conferenceId = ids[0] ?? (d.conferenceId !== null && keptConferences.has(d.conferenceId) ? d.conferenceId : null)
    }
  }

  // Slots: spellings that differ only in case or spacing (`6th Man`, `6th  man`) are one slot.
  if (hasSlotCol) {
    const values = uniqueBy(rows.flatMap((r) => (r.slot === null ? [] : [r.slot])), normalizeHeader)
    const keys = new Set(values.map(normalizeHeader))
    const known = config.roster.slots.filter((s) => keys.has(normalizeHeader(s.name)))
    const knownKeys = new Set(known.map((s) => normalizeHeader(s.name)))
    const taken = new Set(known.map((s) => s.id))
    const added: Slot[] = values
      .filter((v) => !knownKeys.has(normalizeHeader(v)))
      .map((v) => ({ id: uniqueId(slugify(v) || 'slot', taken), name: v, starter: !BENCH_RE.test(v) }))
    config.roster.slots = [...known, ...added]
    if (config.roster.slotMode === 'one-per-slot') {
      config.roster.minPlayers = config.roster.slots.length
      config.roster.maxPlayers = config.roster.slots.length
    }
  }
  const slotIds = new Map(config.roster.slots.map((s) => [normalizeHeader(s.name), s.id]))
  const slotId = (value: string | null) => (value === null ? null : (slotIds.get(normalizeHeader(value)) ?? null))

  // Rating columns
  const baseColumns = config.ratings.columns
  const ratingTargets = mapping.columns.flatMap((c) => (c.target.kind === 'rating' ? [{ header: c.header, ...c.target }] : []))
  const columns: RatingColumn[] = ratingTargets.map((t) => {
    const existing = baseColumns.find((c) => c.id === t.columnId)
    if (existing && existing.kind === t.ratingKind) return existing
    const name = fit(t.header.trim() || t.columnId, LIMITS.rating, 'rating', mapping.headerRow, issues)
    if (t.ratingKind === 'grade') return { id: t.columnId, name, kind: 'grade', weight: 1 }
    let min = 0
    let max = 99
    for (const r of rows) {
      const v = r.ratings[t.columnId]
      if (typeof v !== 'number') continue
      if (v < min) min = v
      if (v > max) max = v
    }
    return { id: t.columnId, name, kind: 'number', min, max, weight: 1 }
  })
  const lostColumns = base.config.ratings.columns.filter((bc) => !columns.some((c) => c.id === bc.id && c.kind === bc.kind))
  if (lostColumns.length > 0 && !sameItems(base.config.ratings.columns, DEFAULTS.ratings.columns)) {
    issues.push({
      level: 'warning',
      code: 'template-column-missing',
      rows: [],
      params: { columns: lostColumns.map((c) => c.name).join(', '), count: lostColumns.length },
    })
  }
  config.ratings.columns = columns
  if (!columns.some((c) => c.id === config.ratings.overallColumnId)) {
    config.ratings.overallColumnId = columns.find((c) => c.kind === 'number')?.id ?? null
  }

  // Players
  const players: Player[] = rows.map((r, i) => ({
    id: pad('p', i + 1, rows.length, 3),
    teamId: teamIdByName.get(r.team)!,
    name: r.name,
    slotId: slotId(r.slot),
    height: r.height,
    nicknames: r.nicknames,
    notes: r.notes,
    ratings: Object.fromEntries(
      columns.map((c) => [c.id, (r.ratings[c.id] ?? null) as RatingValue]),
    ),
  }))

  // Same name twice: on one team it's a real clash; across teams it's a 동명이인 page later.
  const byName = new Map<string, ParsedRow[]>()
  for (const r of rows) {
    const list = byName.get(r.name)
    if (list) list.push(r)
    else byName.set(r.name, [r])
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue
    const teamsOf = unique(list.map((r) => r.team))
    issues.push({
      level: teamsOf.length < list.length ? 'warning' : 'info',
      code: 'duplicate-name',
      rows: list.map((r) => r.row),
      params: { name, teams: teamsOf.map((t) => teams[teamOrder.indexOf(t)]!.shortName).join(', ') },
    })
  }

  return {
    setup: { config, teams, players },
    summary: {
      teams: teams.length,
      players: players.length,
      divisions: config.structure.divisions.length,
      conferences: config.structure.conferences.length,
      slots: config.roster.slots.length,
      ratingColumns: columns.length,
    },
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** The first value for each key, in order. */
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((v) => {
    const k = key(v)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Folds repeated row-level issues (same code and params) into one entry listing every row. */
function mergeIssues(issues: ImportIssue[]): ImportIssue[] {
  const out: ImportIssue[] = []
  const index = new Map<string, ImportIssue>()
  for (const issue of issues) {
    const key = issue.code === 'name-trimmed' || issue.code === 'row-skipped'
      ? issue.code
      : `${issue.code}|${JSON.stringify(issue.params)}`
    const existing = index.get(key)
    if (existing && issue.rows.length > 0) {
      for (const row of issue.rows) existing.rows.push(row)
      if (issue.code === 'name-trimmed') existing.params = { count: existing.rows.length }
    } else {
      const copy = { ...issue, rows: [...issue.rows], params: issue.code === 'name-trimmed' ? { count: 1 } : issue.params }
      index.set(key, copy)
      out.push(copy)
    }
  }
  return out
}
