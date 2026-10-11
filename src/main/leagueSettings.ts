import { join } from 'node:path'
import type { Db } from '@data/db'
import { listEvents, listTeams, loadConfig } from '@data/league'
import { RuleError } from '@data/rules'
import { checkSettings, commitSettings } from '@data/settings'
import { existingLoreFile } from '@lore/folder'
import { applyTeamRenames, moveTeamBackups, planTeamRenames, type TeamRename } from '@lore/teamRename'
import type { SchoolFolderMove } from '@shared/backups'
import type { EventPayloads } from '@shared/events'
import { folderKey } from '@shared/setup'
import type { LeagueSettingsInput, SettingsSaveResult } from '@shared/settings'
import { forgetLore } from '@story/context'
import { syncSchoolCategories } from '@story/wiki'

/**
 * Saves 리그 설정. Everything is checked first (each section's time, the
 * wizard's setup check, renamed schools' lore folders being free); then the
 * renamed schools' lore folders move (put back if anything fails, so a save
 * never leaves lore unlinked); then the database changes in one transaction.
 * A renamed school keeps its wiki page's title (links to it keep working);
 * its players' pages are filed under its new name.
 */
export function saveLeagueSettings(db: Db, leagueFolder: string, input: LeagueSettingsInput): SettingsSaveResult {
  const prepared = checkSettings(db, input)
  const loreDir = join(leagueFolder, 'lore')
  const plan = planTeamRenames(loreDir, prepared.renamed)
  if (plan.taken.length > 0) throw new RuleError(plan.taken.map((t) => ({ code: 'settings-team-lore-taken', params: { name: t.name, path: t.path } })))
  let moved: { undo: () => void }
  try {
    moved = applyTeamRenames(loreDir, plan)
  } catch (e) {
    throw new RuleError([{ code: 'settings-team-lore-locked', params: { message: (e as Error).message } }])
  }
  let result
  try {
    result = commitSettings(db, prepared)
  } catch (e) {
    moved.undo()
    throw e
  }
  if (plan.folders.length + plan.files.length > 0) {
    forgetLore(leagueFolder)
    moveTeamBackups(join(leagueFolder, 'backups', 'lore'), plan)
  }
  let wikiUpdated = 0
  if (prepared.renamed.length > 0) {
    try {
      wikiUpdated = syncSchoolCategories(db, loadConfig(db).config, Date.now())
    } catch (e) {
      console.warn('[wiki] filing players under the renamed schools failed', e)
    }
  }
  return { ...result, loreMoved: plan.folders.length + plan.files.length, wikiUpdated }
}

/** Each school's earlier short names, from 리그 설정 saves (`teams_edited`), latest first. */
export function formerSchoolNames(db: Db): Map<string, string[]> {
  const names = new Map<string, string[]>()
  for (const e of listEvents(db, 'teams_edited').reverse()) {
    for (const t of (e.payload as EventPayloads['teams_edited']).teams ?? []) {
      if (t.renamedFrom) names.set(t.teamId, [...(names.get(t.teamId) ?? []), t.renamedFrom])
    }
  }
  return names
}

/**
 * After a restore, school lore folders left under a name the league no longer
 * uses (a database restored from before a rename, or lore from before one)
 * move to the school's name now, as a rename moves them (its own and its
 * GM's files, same-name players' brackets, the files' backups). `former`
 * gives each school's names its folder may be under, the likeliest first.
 * Only a school with no folder under its name now takes one, and only a
 * folder no school is named after now. Best effort: what can't move (a name
 * taken, a file held open) stays where it is.
 */
export function followSchoolNames(db: Db, leagueFolder: string, former: Map<string, string[]>): SchoolFolderMove[] {
  const loreDir = join(leagueFolder, 'lore')
  const teams = listTeams(db)
  const current = new Set(teams.map((t) => folderKey(t.shortName)))
  const has = (name: string) => existingLoreFile(loreDir, `teams/${name}`) !== null
  const renames: TeamRename[] = []
  const claimed = new Set<string>()
  for (const t of teams) {
    if (has(t.shortName)) continue
    const from = (former.get(t.id) ?? []).find((n) => !current.has(folderKey(n)) && !claimed.has(folderKey(n)) && has(n))
    if (!from) continue
    claimed.add(folderKey(from))
    renames.push({ teamId: t.id, from, to: t.shortName })
  }
  const moved: SchoolFolderMove[] = []
  for (const r of renames) {
    const plan = planTeamRenames(loreDir, [r])
    if (plan.taken.length > 0 || plan.folders.length === 0) {
      console.warn(`[lore] ${r.from} stays: its files can't take the name ${r.to}`, plan.taken)
      continue
    }
    try {
      applyTeamRenames(loreDir, plan)
    } catch (e) {
      console.warn(`[lore] could not move ${r.from} to ${r.to}`, e)
      continue
    }
    moveTeamBackups(join(leagueFolder, 'backups', 'lore'), plan)
    moved.push({ from: r.from, to: r.to })
  }
  if (moved.length > 0) forgetLore(leagueFolder)
  return moved
}
