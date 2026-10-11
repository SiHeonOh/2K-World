import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { folderKey, isFolderSafe } from '@shared/setup'
import { kindOf, parseLoreFile, playerNameOf, type LoreEntry, type LoreError, type LoreSections } from './parse'

/** Every lore file in a folder, parsed. Names starting with `_` (templates) are skipped. */
export function loadLoreFolder(dir: string): { entries: LoreEntry[]; errors: LoreError[] } {
  const entries: LoreEntry[] = []
  const errors: LoreError[] = []
  const walk = (folder: string) => {
    if (!existsSync(folder)) return
    let names: string[]
    try {
      names = readdirSync(folder).sort()
    } catch (e) {
      errors.push({ file: relative(dir, folder).replace(/\\/g, '/'), line: 0, code: 'unreadable', message: (e as Error).message })
      return
    }
    for (const name of names) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      const full = join(folder, name)
      const rel = relative(dir, full).replace(/\\/g, '/')
      // A file mid-save (an editor's atomic write) or a cloud placeholder: report it, keep reading the rest.
      try {
        if (statSync(full).isDirectory()) walk(full)
        else if (name.toLowerCase().endsWith('.md')) {
          if (!rel.startsWith('teams/') && !rel.startsWith('world/')) continue
          const result = parseLoreFile(rel, readFileSync(full, 'utf8'))
          if (result.entry) entries.push(result.entry)
          errors.push(...result.errors)
        }
      } catch (e) {
        errors.push({ file: rel, line: 0, code: 'unreadable', message: (e as Error).message })
      }
    }
  }
  walk(join(dir, 'teams'))
  walk(join(dir, 'world'))
  return { entries, errors }
}

type PlayerRef = { id: string; name: string; teamId: string; firstTeamId?: string; teamIds?: string[] }

export interface LeagueRefs {
  teams: { id: string; shortName: string }[]
  /**
   * `firstTeamId`: his team before his first trade or swap; `teamIds`: every
   * team he's been on. Left out, both are just his current team.
   */
  players: PlayerRef[]
}

export interface LoreLinks {
  team: Map<string, LoreEntry>
  gm: Map<string, LoreEntry>
  player: Map<string, LoreEntry>
  world: LoreEntry[]
  /** Files that match no team or player in the league. */
  orphanFiles: string[]
  /** Players with no lore file. */
  playersWithout: string[]
  /** Player files linked from outside his current team's folder, and where each belongs (`relocateLore` moves them). */
  misplaced: { file: string; playerId: string; to: string }[]
  /** Players more than one file points at; `kept` is the one used (the one in his team's folder), if any. */
  duplicates: { playerId: string; files: string[]; kept: string | null }[]
}

/** Names compared the way people see them: Korean typed on a Mac (NFD) matches the same name typed on Windows (NFC). */
const nfc = (s: string) => s.normalize('NFC')

/**
 * Links lore files to the league: a team by its folder name (the team's
 * short name, matched as Windows matches folders), a player by his file name
 * in the folder of any team he's been on, so a traded player keeps his lore
 * before his file is moved. A file in a school he's never played for (an
 * alumnus with the same name) isn't his.
 * Same-name players carry their first team in brackets, e.g. 김하람(한빛고).
 * A bracket naming one player's first team is his alone: if he's never been
 * at that folder's school, the file is left unlinked rather than guessed. With
 * no bracket (or one naming nobody's), the folder decides: who started there,
 * then who's there now.
 */
export function linkLore(entries: LoreEntry[], league: LeagueRefs): LoreLinks {
  const teamByName = new Map(league.teams.map((t) => [folderKey(t.shortName), t.id]))
  const shortName = new Map(league.teams.map((t) => [t.id, t.shortName]))
  const first = (p: PlayerRef) => p.firstTeamId ?? p.teamId
  const beenOn = (p: PlayerRef, teamId: string) => p.teamId === teamId || first(p) === teamId || (p.teamIds?.includes(teamId) ?? false)
  const one = (list: PlayerRef[]) => (list.length === 1 ? list[0]! : null)
  const ownerOf = (file: string, folderTeamId: string): PlayerRef | null => {
    const { name, originalTeam } = playerNameOf(file)
    const named = league.players.filter((p) => nfc(p.name) === nfc(name))
    const origin = originalTeam === null ? undefined : teamByName.get(folderKey(originalTeam))
    const claimed = origin === undefined ? [] : named.filter((p) => first(p) === origin)
    const pool = (claimed.length > 0 ? claimed : named).filter((p) => beenOn(p, folderTeamId))
    return one(pool) ?? one(pool.filter((p) => first(p) === folderTeamId)) ?? one(pool.filter((p) => p.teamId === folderTeamId))
  }
  /**
   * Where his file goes in his team's folder: under a name that still finds
   * him there, or nowhere (it stays put, still linked). A same-name player's
   * file takes his first team in brackets, so later moves still find it.
   */
  const destination = (p: PlayerRef, base: string): string | null => {
    const folder = shortName.get(p.teamId)
    const origin = shortName.get(first(p))
    if (!folder) return null
    const names = [base]
    const shared = league.players.some((o) => o.id !== p.id && nfc(o.name) === nfc(p.name))
    if (shared && origin && nfc(base) !== nfc(`${p.name}(${origin}).md`)) names.unshift(`${p.name}(${origin}).md`)
    return names.map((n) => `teams/${folder}/${n}`).find((rel) => ownerOf(rel, p.teamId)?.id === p.id) ?? null
  }

  const links: LoreLinks = {
    team: new Map(),
    gm: new Map(),
    player: new Map(),
    world: [],
    orphanFiles: [],
    playersWithout: [],
    misplaced: [],
    duplicates: [],
  }
  const claims = new Map<string, { entry: LoreEntry; folderTeamId: string; owner: PlayerRef }[]>()
  for (const e of entries) {
    if (e.kind === 'world') {
      links.world.push(e)
      continue
    }
    const teamId = teamByName.get(folderKey(e.team))
    if (!teamId) {
      links.orphanFiles.push(e.file)
      continue
    }
    if (e.kind === 'team') links.team.set(teamId, e)
    else if (e.kind === 'gm') links.gm.set(teamId, e)
    else {
      const owner = ownerOf(e.file, teamId)
      if (!owner) links.orphanFiles.push(e.file)
      else claims.set(owner.id, [...(claims.get(owner.id) ?? []), { entry: e, folderTeamId: teamId, owner }])
    }
  }
  // Two files for one player: the one in his team's folder is used, and you're told about both.
  for (const files of claims.values()) {
    const p = files[0]!.owner
    const kept = files.find((f) => f.folderTeamId === p.teamId) ?? (files.length === 1 ? files[0]! : null)
    for (const f of files) if (f !== kept) links.orphanFiles.push(f.entry.file)
    if (files.length > 1) links.duplicates.push({ playerId: p.id, files: files.map((f) => f.entry.file), kept: kept?.entry.file ?? null })
    if (!kept) continue
    links.player.set(p.id, kept.entry)
    if (kept.folderTeamId !== p.teamId) {
      const to = destination(p, kept.entry.file.split('/').at(-1)!)
      if (to) links.misplaced.push({ file: kept.entry.file, playerId: p.id, to })
    }
  }
  links.playersWithout = league.players.filter((p) => !links.player.has(p.id)).map((p) => p.id)
  return links
}

/** The on-disk spelling of `name` in `parent` (same file to Windows: case and Unicode form aside), if there is one. */
function onDisk(parent: string, name: string): string | null {
  try {
    return readdirSync(parent).find((n) => folderKey(n) === folderKey(name)) ?? null
  } catch {
    return null
  }
}

/** Where a move to `rel` (teams/<team>/<file>) really lands: into the team folder already on disk, whatever its spelling. */
function landing(dir: string, rel: string): { rel: string; taken: boolean } {
  const [, team, file] = rel.split('/') as [string, string, string]
  const folder = onDisk(join(dir, 'teams'), team) ?? team
  return { rel: `teams/${folder}/${file}`, taken: onDisk(join(dir, 'teams', folder), file) !== null }
}

/** The file already at `rel`, of any kind (case and Unicode form aside), as it's spelled on disk; null when there's none. */
export function existingLoreFile(dir: string, rel: string): string | null {
  const found: string[] = []
  let at = dir
  for (const part of rel.split('/')) {
    const name = onDisk(at, part)
    if (name === null) return null
    found.push(name)
    at = join(at, name)
  }
  return found.join('/')
}

/** Whether a different file already has the name a move would take. */
export function loreNameTaken(dir: string, rel: string): boolean {
  return kindOf(rel)?.kind === 'player' && landing(dir, rel).taken
}

export interface RelocateResult {
  moved: { from: string; to: string }[]
  /** 'taken': a different file already has that name there (never overwritten); 'failed': the move itself failed (locked, read-only…). */
  skipped: { file: string; to: string; reason: 'taken' | 'failed'; message: string }[]
}

/**
 * Moves player files into their current team's folder (the only change the
 * app makes to your lore files). It never overwrites: a name already taken
 * there leaves the file where it is, still linked, for you to sort out.
 */
export function relocateLore(dir: string, misplaced: LoreLinks['misplaced']): RelocateResult {
  const result: RelocateResult = { moved: [], skipped: [] }
  for (const m of misplaced) {
    // Only ever from one team folder into another (a name with a slash would reach elsewhere).
    if (kindOf(m.file)?.kind !== 'player' || kindOf(m.to)?.kind !== 'player' || !isFolderSafe(m.to.split('/').at(-1)!.replace(/\.md$/i, ''))) {
      result.skipped.push({ file: m.file, to: m.to, reason: 'failed', message: 'not a file name a team folder can hold' })
      continue
    }
    const target = landing(dir, m.to)
    if (target.taken) {
      result.skipped.push({ file: m.file, to: m.to, reason: 'taken', message: '' })
      continue
    }
    try {
      const to = join(dir, target.rel)
      mkdirSync(dirname(to), { recursive: true })
      renameSync(join(dir, m.file), to)
      result.moved.push({ from: m.file, to: target.rel })
    } catch (e) {
      result.skipped.push({ file: m.file, to: m.to, reason: 'failed', message: (e as Error).message })
    }
  }
  return result
}

export type Audience = 'public' | 'rumor' | 'gm' | 'self'

/** Which sections each audience may see: writers 공개; rumor-minded 공개 + 소문; GMs too; the player himself everything. */
export const AUDIENCE_SECTIONS: Record<Audience, (keyof LoreSections)[]> = {
  public: ['public'],
  rumor: ['public', 'rumor'],
  gm: ['public', 'rumor'],
  self: ['public', 'rumor', 'secret'],
}

/** Labels that tell a writer how to treat each block. */
export const SECTION_LABELS: Record<keyof LoreSections, string> = {
  public: '[공개]',
  rumor: '[소문 — 확인 안 됨]',
  secret: '[비밀 — 직접 말하지 말 것]',
}

/** The lore a given audience may use about one entity, labelled; empty sections are left out. */
export function loreBlock(entry: LoreEntry | undefined, title: string, audience: Audience): string {
  if (!entry) return ''
  const parts = AUDIENCE_SECTIONS[audience]
    .filter((k) => entry.sections[k] !== '')
    .map((k) => `${SECTION_LABELS[k]}\n${entry.sections[k]}`)
  return parts.length === 0 ? '' : `## ${title}\n${parts.join('\n\n')}`
}
