import { transaction, type Db } from '@data/db'
import { currentSeason, listPlayers, listTeams, loadConfig } from '@data/league'
import { updatePlayers } from '@data/roster'
import { RuleError } from '@data/rules'
import { backlinkCount, pageByRef, pageByTitle, renamePage } from '@data/wiki'
import type { PlayerEdit, RenameResult, RosterSaveResult } from '@shared/roster'
import { wikiTitles } from '@story/wiki'
import type { LoreService } from './lore'

/**
 * Saves roster edits. Renamed players' lore files are planned first, and a
 * new name already taken by another file refuses the whole save (nothing
 * changes). Then the facts and the wiki titles change in one transaction,
 * and the files are renamed. What a rename can't carry along (other files'
 * references, wiki links to the old title) is reported, never rewritten.
 */
export function editRoster(db: Db, leagueFolder: string, lore: LoreService, edits: PlayerEdit[]): RosterSaveResult {
  const { plans, taken } = lore.planRenames(db, leagueFolder, edits)
  if (taken.length > 0) throw new RuleError(taken.map((t) => ({ code: 'roster-lore-taken', params: { name: t.name, file: t.file } })))

  const { changes, titles } = transaction(db, () => {
    const changes = updatePlayers(db, edits)
    const titles = new Map<string, { title: string | null; oldTitle: string | null }>()
    const renamed = changes.filter((c) => c.renamedFrom !== null)
    if (renamed.length > 0) {
      const wanted = wikiTitles(loadConfig(db).config, currentSeason(db).label, listTeams(db), listPlayers(db)).player
      const pages = renamed.map((c) => ({ c, page: pageByRef(db, 'player', c.playerId) }))
      // Two passes, so two players swapping names swap pages too.
      for (const { page } of pages) if (page) renamePage(db, page.id, `~renaming~${page.id}~${Date.now()}`)
      for (const { c, page } of pages) {
        if (!page) {
          titles.set(c.playerId, { title: null, oldTitle: null })
          continue
        }
        const title = wanted.get(c.playerId)
        const ok = title !== undefined && !pageByTitle(db, title) && renamePage(db, page.id, title)
        if (!ok) renamePage(db, page.id, page.title)
        titles.set(c.playerId, { title: ok ? title! : null, oldTitle: page.title })
      }
    }
    return { changes, titles }
  })

  const moved = lore.applyRenames(leagueFolder, plans.filter((x) => changes.some((c) => c.playerId === x.playerId && c.renamedFrom !== null)))
  const players = listPlayers(db)
  const renamed: RenameResult[] = []
  for (const c of changes) {
    if (c.renamedFrom === null) continue
    const me = players.find((p) => p.id === c.playerId)!
    const file = moved.get(c.playerId) ?? null
    const t = titles.get(c.playerId)
    const sharedName = players.some((p) => p.id !== me.id && p.name === me.name)
    const myFile = file ? (file.status === 'moved' ? file.to : file.from) : null
    renamed.push({
      playerId: c.playerId,
      from: c.renamedFrom,
      to: me.name,
      lore: file,
      wikiTitle: t?.title ?? null,
      loreReferences: lore.referencesTo(leagueFolder, c.renamedFrom, myFile),
      wikiLinks: t?.oldTitle && t.title ? backlinkCount(db, t.oldTitle) : 0,
      sharedName,
      ambiguousReferences: sharedName ? lore.referencesTo(leagueFolder, me.name, myFile, true) : [],
    })
  }
  return { changed: changes.length, renamed }
}
