import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { folderKey } from '@shared/setup'
import { playerNameOf } from './parse'

/**
 * A school's short name is its lore folder's name: `teams/<school>/` holds
 * `<school>.md`, `<school> 단장.md` and its players, and a same-name player's
 * file names the school he started at in brackets (`김철수(<school>).md`).
 * Renaming a school moves all of that along, so its lore stays linked.
 * Inside the files nothing changes.
 */

export interface TeamRename {
  teamId: string
  from: string
  to: string
}

/** A rename inside the lore folder, as paths relative to it (files are named in their folder's new name). */
interface Move {
  from: string
  to: string
}

export interface TeamRenamePlan {
  folders: Move[]
  files: Move[]
  /** Names a rename would take that a file or folder this plan doesn't move already has. */
  taken: { name: string; path: string }[]
}

/** The on-disk spelling of `name` in `parent` (the same to Windows: case and Unicode form aside). */
function onDisk(parent: string, name: string): string | null {
  try {
    return readdirSync(parent).find((n) => folderKey(n) === folderKey(name)) ?? null
  } catch {
    return null
  }
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Works out every folder and file a set of school renames moves, before
 * anything changes. A school whose folder is already under the new name, with
 * none under the old one, takes it over as it is (a database restored from
 * before a rename, then renamed again): no other school can own that name,
 * as short names are unique.
 */
export function planTeamRenames(loreDir: string, renames: readonly TeamRename[]): TeamRenamePlan {
  const plan: TeamRenamePlan = { folders: [], files: [], taken: [] }
  const teamsDir = join(loreDir, 'teams')
  const real = renames.filter((r) => r.from !== r.to)
  if (real.length === 0 || !existsSync(teamsDir)) return plan
  const renameOf = (name: string) => real.find((r) => folderKey(r.from) === folderKey(name))
  // Folders this batch moves away are free to take (two schools swapping names); a case-only change is the same folder.
  for (const r of real) {
    const disk = onDisk(teamsDir, r.from)
    const there = onDisk(teamsDir, r.to)
    if (there && folderKey(there) !== folderKey(r.from) && !renameOf(there)) {
      if (disk) plan.taken.push({ name: r.to, path: `teams/${there}` })
      continue
    }
    if (disk) plan.folders.push({ from: `teams/${disk}`, to: `teams/${r.to}` })
  }
  for (const disk of readdirSync(teamsDir)) {
    if (disk.startsWith('_') || disk.startsWith('.') || !isDir(join(teamsDir, disk))) continue
    const mine = renameOf(disk)
    const folder = mine ? mine.to : disk
    const files = readdirSync(join(teamsDir, disk)).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
    const moves: Move[] = []
    for (const file of files) {
      const base = file.replace(/\.md$/i, '')
      let to: string | null = null
      if (mine && folderKey(base) === folderKey(mine.from)) to = `${mine.to}.md`
      else if (mine && folderKey(base) === folderKey(`${mine.from} 단장`)) to = `${mine.to} 단장.md`
      else {
        // A same-name player's file names the school he started at.
        const { name, originalTeam } = playerNameOf(file)
        const started = originalTeam === null ? undefined : renameOf(originalTeam)
        if (started) to = `${name}(${started.to}).md`
      }
      if (to !== null && to !== file) moves.push({ from: `teams/${folder}/${file}`, to: `teams/${folder}/${to}` })
    }
    const leaving = new Set(moves.map((m) => folderKey(m.from.split('/').at(-1)!)))
    for (const m of moves) {
      const name = m.to.split('/').at(-1)!
      const clash = files.find((f) => folderKey(f) === folderKey(name))
      if (clash && !leaving.has(folderKey(clash))) plan.taken.push({ name: name.replace(/\.md$/i, ''), path: `teams/${folder}/${clash}` })
    }
    plan.files.push(...moves)
  }
  return plan
}

/**
 * Makes the planned renames: every folder, then every file, first to a
 * parked name (a leading '_', which the loader and renames skip, but lore
 * snapshots keep, so one stranded by a crash is still backed up) and then to
 * its new one, so swaps and case-only changes work and nothing is
 * overwritten. If
 * any rename fails (a file open in another program), everything done so far
 * is put back and the error is thrown. `undo` puts it all back later (when
 * the database save after it fails).
 */
export function applyTeamRenames(loreDir: string, plan: TeamRenamePlan): { undo: () => void } {
  const done: Move[] = []
  const move = (from: string, to: string) => {
    if (existsSync(to) && folderKey(from) !== folderKey(to)) throw new Error(`${to} already exists`)
    renameSync(from, to)
    done.push({ from, to })
  }
  const undo = () => {
    for (const m of done.splice(0).reverse()) {
      try {
        renameSync(m.to, m.from)
      } catch (e) {
        console.warn(`[lore] could not put ${m.from} back; it's at ${m.to}`, e)
      }
    }
  }
  const tag = randomBytes(4).toString('hex')
  try {
    const parked = plan.folders.map((m, i) => {
      const tmp = join(loreDir, 'teams', `_renaming-${tag}-${i}`)
      move(join(loreDir, m.from), tmp)
      return { tmp, to: join(loreDir, m.to) }
    })
    for (const p of parked) move(p.tmp, p.to)
    const parkedFiles = plan.files.map((m, i) => {
      const from = join(loreDir, m.from)
      const tmp = join(dirname(from), `_renaming-${tag}-${i}.md`)
      move(from, tmp)
      return { tmp, to: join(loreDir, m.to) }
    })
    for (const p of parkedFiles) move(p.tmp, p.to)
  } catch (e) {
    undo()
    throw e
  }
  return { undo }
}

/**
 * The files' backups (backups/lore/<path without .md>/) follow them, best
 * effort: a backup folder that can't move stays where it was, still on disk.
 */
export function moveTeamBackups(backupsDir: string, plan: TeamRenamePlan): void {
  const tag = randomBytes(4).toString('hex')
  // Parked first, like the files, so two schools swapping names swap their backups too.
  const relocate = (moves: Move[]) => {
    const parked: { tmp: string; dst: string; from: string }[] = []
    moves.forEach((m, i) => {
      const parent = join(backupsDir, dirname(m.from))
      const disk = onDisk(parent, m.from.split('/').at(-1)!)
      if (!disk) return
      const tmp = join(parent, `.renaming-${tag}-${i}`)
      try {
        renameSync(join(parent, disk), tmp)
        parked.push({ tmp, dst: join(backupsDir, m.to), from: m.from })
      } catch (e) {
        console.warn(`[lore] could not move the backups of ${m.from}`, e)
      }
    })
    for (const p of parked) {
      try {
        if (!existsSync(p.dst)) {
          mkdirSync(dirname(p.dst), { recursive: true })
          renameSync(p.tmp, p.dst)
        } else for (const f of readdirSync(p.tmp)) if (!existsSync(join(p.dst, f))) renameSync(join(p.tmp, f), join(p.dst, f))
      } catch (e) {
        console.warn(`[lore] could not move the backups of ${p.from} (left at ${p.tmp})`, e)
      }
    }
  }
  relocate(plan.folders)
  relocate(plan.files.map((m) => ({ from: m.from.replace(/\.md$/i, ''), to: m.to.replace(/\.md$/i, '') })))
}
