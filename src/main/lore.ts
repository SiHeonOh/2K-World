import { createHash, randomBytes } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Db } from '@data/db'
import { listEvents, listPlayers, listTeams } from '@data/league'
import { rosterHistory } from '@data/moves'
import { editLore, LoreEditError, sameValue, splitSectionsOf, type LoreEditable } from '@lore/edit'
import { existingLoreFile, linkLore, loadLoreFolder, loreNameTaken, relocateLore, type LoreLinks, type RelocateResult } from '@lore/folder'
import { FRONTMATTER, kindOf, loreSchemaOf, parseLoreFile, type LoreEntry, type LoreKind } from '@lore/parse'
import { folderKey, isFolderSafe } from '@shared/setup'
import type { PlayerEdit } from '@shared/roster'
import type { LoreBackupView, LoreCreateTarget, LoreDocView, LoreEditableView, LoreIndexView, LoreLink, LoreSaveInput, LoreSaveResult, LoreTableRow, LoreTableView } from '@shared/lore'
import { forgetLore, loreRefs } from '@story/context'
import { AppError } from './errors'

/** Where a lore file's earlier versions are kept: backups/lore/<its path without .md>/. */
const backupDirOf = (leagueFolder: string, rel: string) => join(leagueFolder, 'backups', 'lore', ...rel.replace(/\.md$/i, '').split('/'))

/** A file's backups follow it when it moves, so its history isn't left behind. */
function moveBackups(leagueFolder: string, from: string, to: string): void {
  const src = backupDirOf(leagueFolder, from)
  const dst = backupDirOf(leagueFolder, to)
  if (!existsSync(src) || src === dst) return
  try {
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true })
      renameSync(src, dst)
      return
    }
    for (const f of readdirSync(src)) if (!existsSync(join(dst, f))) renameSync(join(src, f), join(dst, f))
  } catch (e) {
    console.warn(`[lore] could not move the backups of ${from}`, e)
  }
}

/**
 * Team folders follow current rosters: moves each player's lore file into his
 * team's folder. Runs when a league opens and after trades, draft swaps and
 * their vetoes. Files are only moved, never rewritten or overwritten.
 */
export function syncLoreFolder(db: Db, leagueFolder: string): RelocateResult {
  const dir = join(leagueFolder, 'lore')
  if (!existsSync(join(dir, 'teams'))) return { moved: [], skipped: [] }
  const { misplaced } = linkLore(loadLoreFolder(dir).entries, loreRefs(db))
  if (misplaced.length === 0) return { moved: [], skipped: [] }
  const result = relocateLore(dir, misplaced)
  if (result.moved.length > 0) forgetLore(leagueFolder)
  for (const m of result.moved) {
    moveBackups(leagueFolder, m.from, m.to)
    console.info(`[lore] moved ${m.from} → ${m.to}`)
  }
  for (const s of result.skipped) console.warn(`[lore] could not move ${s.file} → ${s.to} (${s.reason}) ${s.message}`)
  return result
}

/** A renamed player's lore file: where it is, and where his new name puts it. */
export interface RenamePlan {
  playerId: string
  from: string
  to: string
}

/** Backups kept per file; older ones are removed as new ones arrive. */
const BACKUPS_PER_FILE = 30
const BACKUP_ID = /^\d{4}-\d\d-\d\dT[\d-]+Z(?:-\d+)?$/
const PLACEHOLDER: Record<LoreKind, string> = { player: '선수이름', team: '학교이름', gm: '학교이름', world: '주제이름' }

/** The smallest valid file of each kind, if neither the league nor the app has a template. */
const FALLBACK_TEMPLATE: Record<LoreKind, string> = {
  player: '---\nid: 선수이름\n---\n\n# 선수이름\n\n## 공개\n\n## 소문\n\n## 비밀\n',
  team: '---\nid: 학교이름\n---\n\n# 학교이름\n\n## 공개\n\n## 소문\n\n## 비밀\n',
  gm: '---\nid: 학교이름 단장\nteam: 학교이름\n---\n\n# 학교이름 단장\n\n## 공개\n\n## 소문\n\n## 비밀\n',
  world: '---\nid: 주제이름\n---\n\n# 주제이름\n\n## 공개\n\n## 소문\n\n## 비밀\n',
}

const version = (text: string) => createHash('sha1').update(text).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
/** Strict: a file that isn't UTF-8 is read for showing, never written back (its text would be lost). */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** What the editor needs to make files without re-reading the folder for each one. */
interface Prepared {
  teams: ReturnType<typeof listTeams>
  players: ReturnType<typeof listPlayers>
  history: ReturnType<typeof rosterHistory>
  links: LoreLinks
}

/**
 * The lore editor's side of the folder: reads one file for the form, writes
 * edits back without disturbing anything it didn't change, keeps a byte-for-
 * byte backup of every version it replaces, and makes new files from templates.
 */
export class LoreService {
  constructor(private readonly defaultsDir: string) {}

  // ── Paths ──────────────────────────────────────────────────────────────

  private loreDir(leagueFolder: string) {
    return join(leagueFolder, 'lore')
  }

  /**
   * A path the editor may touch: a .md file in teams/<team>/ or world/, never
   * a template, never outside the folder (not through a link inside it either).
   */
  private safe(leagueFolder: string, rel: unknown): { rel: string; full: string } {
    if (typeof rel !== 'string') throw new AppError('invalid-input', 'bad lore path')
    const clean = rel.replace(/\\/g, '/')
    const parts = clean.split('/')
    const ok =
      clean.toLowerCase().endsWith('.md') &&
      parts.every((p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('_') && !p.startsWith('.')) &&
      kindOf(clean) !== null &&
      parts.every((p) => isFolderSafe(p.replace(/\.md$/i, '')))
    const dir = resolve(this.loreDir(leagueFolder))
    const full = resolve(dir, clean)
    if (!ok || !full.startsWith(dir + sep)) throw new AppError('invalid-input', `bad lore path: ${clean}`)
    if (existsSync(dir)) {
      const root = realpathSync.native(dir)
      let probe = full
      while (!existsSync(probe) && probe.startsWith(dir + sep)) probe = dirname(probe)
      const real = realpathSync.native(probe)
      if (real !== root && !real.startsWith(root + sep)) throw new AppError('invalid-input', `lore path leaves the folder: ${clean}`)
    }
    return { rel: clean, full }
  }

  // ── The index ──────────────────────────────────────────────────────────

  /** The lore folder as the app reads it: every file, what it's linked to, and anything that needs you. */
  index(db: Db, leagueFolder: string): LoreIndexView {
    const dir = this.loreDir(leagueFolder)
    const { entries, errors } = loadLoreFolder(dir)
    const teams = listTeams(db)
    const players = listPlayers(db)
    const links = linkLore(entries, loreRefs(db))
    const linked = new Map<string, { name: string; link: LoreLink }>()
    for (const [id, e] of links.team) linked.set(e.file, { name: teams.find((t) => t.id === id)?.shortName ?? id, link: { kind: 'team', teamId: id } })
    for (const [id, e] of links.gm) linked.set(e.file, { name: `${teams.find((t) => t.id === id)?.shortName ?? id} 단장`, link: { kind: 'gm', teamId: id } })
    for (const [id, e] of links.player) {
      const p = players.find((x) => x.id === id)
      linked.set(e.file, { name: p?.name ?? id, link: { kind: 'player', playerId: id, teamId: p?.teamId ?? '' } })
    }
    for (const e of links.world) linked.set(e.file, { name: e.settings.id, link: { kind: 'world' } })
    const without = new Set(links.playersWithout)
    const firstTeams: Record<string, string> = {}
    for (const [id, h] of rosterHistory(db)) firstTeams[id] = h.first
    const created = listEvents(db, 'league_created')[0]?.createdAt ?? ''
    return {
      folder: dir,
      exists: existsSync(dir),
      files: entries.map((e) => ({
        file: e.file,
        kind: e.kind,
        linkedTo: linked.get(e.file)?.name ?? null,
        link: linked.get(e.file)?.link ?? null,
        sizes: { public: e.sections.public.length, rumor: e.sections.rumor.length, secret: e.sections.secret.length },
      })),
      errors,
      missing: players.filter((p) => without.has(p.id)).map((p) => ({ id: p.id, name: p.name, teamId: p.teamId })),
      missingTeams: teams.filter((t) => !links.team.has(t.id)).map((t) => t.id),
      missingGms: teams.filter((t) => !links.gm.has(t.id)).map((t) => t.id),
      misplaced: links.misplaced.map((m) => ({ file: m.file, to: m.to, taken: loreNameTaken(dir, m.to) })),
      duplicates: links.duplicates.map((d) => ({ name: players.find((p) => p.id === d.playerId)?.name ?? d.playerId, files: d.files, kept: d.kept })),
      firstTeams,
      draftScope: `${resolve(dir)}|${created}`,
    }
  }

  /**
   * Every player, GM and school with its file's settings, for editing many at
   * once. A file that doesn't read is marked broken (it's fixed in the editor).
   */
  table(db: Db, leagueFolder: string): LoreTableView {
    const dir = this.loreDir(leagueFolder)
    const { entries, errors } = loadLoreFolder(dir)
    const teams = listTeams(db)
    const players = listPlayers(db)
    const links = linkLore(entries, loreRefs(db))
    const broken = [...new Set(errors.map((e) => e.file))]
    const folderOf = (file: string) => file.split('/')[1]?.normalize('NFC').toLowerCase() ?? ''
    const nameOf = (file: string) => (file.split('/').pop() ?? '').replace(/\.md$/i, '').normalize('NFC')
    const brokenFile = (shortName: string, matches: (name: string) => boolean) =>
      broken.find((f) => f.startsWith('teams/') && folderOf(f) === shortName.normalize('NFC').toLowerCase() && matches(nameOf(f))) ?? null
    const row = (kind: LoreTableRow['kind'], teamId: string, entry: LoreEntry | undefined, fallback: string | null, playerId?: string): LoreTableRow => ({
      kind,
      teamId,
      ...(playerId ? { playerId } : {}),
      file: entry?.file ?? fallback,
      editable: entry ? ({ kind: entry.kind, settings: entry.settings, sections: entry.sections } as LoreEditableView) : null,
      broken: !entry && fallback !== null,
      sizes: entry ? { public: entry.sections.public.length, rumor: entry.sections.rumor.length, secret: entry.sections.secret.length } : null,
    })
    const rows: LoreTableRow[] = []
    for (const t of teams) {
      rows.push(row('team', t.id, links.team.get(t.id), links.team.has(t.id) ? null : brokenFile(t.shortName, (n) => n === t.shortName.normalize('NFC'))))
      rows.push(row('gm', t.id, links.gm.get(t.id), links.gm.has(t.id) ? null : brokenFile(t.shortName, (n) => n === `${t.shortName} 단장`.normalize('NFC'))))
    }
    for (const p of players) {
      const team = teams.find((t) => t.id === p.teamId)!
      const entry = links.player.get(p.id)
      const name = p.name.normalize('NFC')
      rows.push(row('player', p.teamId, entry, entry ? null : brokenFile(team.shortName, (n) => n === name || n.startsWith(`${name}(`)), p.id))
    }
    const created = listEvents(db, 'league_created')[0]?.createdAt ?? ''
    return { draftScope: `${resolve(dir)}|${created}`, rows }
  }

  // ── One file ───────────────────────────────────────────────────────────

  open(leagueFolder: string, rel: string): LoreDocView {
    const path = this.safe(leagueFolder, rel)
    if (!existsSync(path.full)) throw new AppError('not-found', `no lore file ${path.rel}`)
    const { text, utf8 } = this.read(path.full)
    return this.view(leagueFolder, path.rel, text, utf8)
  }

  private read(full: string): { text: string; utf8: boolean } {
    let bytes: Buffer
    try {
      bytes = readFileSync(full)
    } catch (e) {
      throw new AppError('file-read', (e as Error).message)
    }
    try {
      return { text: UTF8.decode(bytes), utf8: true }
    } catch {
      return { text: bytes.toString('utf8'), utf8: false }
    }
  }

  private view(leagueFolder: string, rel: string, text: string, utf8 = true): LoreDocView {
    const { entry, errors } = parseLoreFile(rel, text)
    const body = text.replace(/^﻿/, '').match(FRONTMATTER)?.[2] ?? ''
    return {
      file: rel,
      kind: kindOf(rel)!.kind,
      text,
      version: version(text),
      utf8,
      editable: entry ? ({ kind: entry.kind, settings: entry.settings, sections: entry.sections } as LoreEditableView) : null,
      errors,
      splitSections: entry ? splitSectionsOf(body) : [],
      backups: this.backups(leagueFolder, rel),
    }
  }

  save(leagueFolder: string, input: LoreSaveInput): LoreSaveResult {
    const path = this.safe(leagueFolder, input.file)
    if (!existsSync(path.full)) return { status: 'gone' }
    const { text: now, utf8 } = this.read(path.full)
    if (!utf8) return { status: 'error', code: 'not-utf8', detail: '' }

    if (input.mode === 'raw') {
      if (typeof input.text !== 'string') throw new AppError('invalid-input', 'no text')
      if (version(now) !== input.version) return { status: 'changed', doc: this.view(leagueFolder, path.rel, now) }
      if (input.text === now) return { status: 'unchanged', doc: this.view(leagueFolder, path.rel, now) }
      const { errors } = parseLoreFile(path.rel, input.text)
      if (errors.length > 0 && input.force !== true) return { status: 'invalid', errors }
      this.write(leagueFolder, path, input.text)
      return { status: 'saved', doc: this.view(leagueFolder, path.rel, input.text), merged: false }
    }

    // The form must be for this kind of file, and what it asks for must be valid settings.
    const kind = kindOf(path.rel)!.kind
    if (input.base.kind !== kind || input.next.kind !== kind || !loreSchemaOf(kind).safeParse(input.next.settings).success) {
      throw new AppError('invalid-input', `lore settings don't fit ${path.rel}`)
    }
    let result
    try {
      result = editLore(now, path.rel, input.base as unknown as LoreEditable, input.next as unknown as LoreEditable, { overwrite: input.overwrite === true })
    } catch (e) {
      if (e instanceof LoreEditError) return { status: 'error', code: e.code, detail: e.detail }
      throw e
    }
    if ('conflicts' in result) return { status: 'conflict', fields: result.conflicts, doc: this.view(leagueFolder, path.rel, now) }
    if (!result.changed) return { status: 'unchanged', doc: this.view(leagueFolder, path.rel, now) }
    this.write(leagueFolder, path, result.text)
    // The file had moved on from what the editor loaded: its other changes were kept.
    const before = parseLoreFile(path.rel, now).entry
    const merged = !sameEditable(before ? ({ kind: before.kind, settings: before.settings, sections: before.sections } as LoreEditableView) : null, input.base)
    return { status: 'saved', doc: this.view(leagueFolder, path.rel, result.text), merged }
  }

  /** Keeps the file as it is now (byte for byte), then swaps the new text in whole (never a half-written file). */
  private write(leagueFolder: string, path: { rel: string; full: string }, content: string | Buffer): void {
    if (existsSync(path.full)) this.backup(leagueFolder, path)
    const tmp = join(dirname(path.full), `.${basename(path.full)}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      mkdirSync(dirname(path.full), { recursive: true })
      writeFileSync(tmp, content)
      try {
        renameSync(tmp, path.full)
      } catch {
        // Some editors hold the file so it can't be replaced, only written over.
        writeFileSync(path.full, content)
      }
    } catch (e) {
      throw new AppError('file-read', `could not save ${path.rel}: ${(e as Error).message}`)
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
    forgetLore(leagueFolder)
  }

  // ── Backups ────────────────────────────────────────────────────────────

  private backup(leagueFolder: string, path: { rel: string; full: string }): void {
    const dir = backupDirOf(leagueFolder, path.rel)
    try {
      mkdirSync(dir, { recursive: true })
      const at = stamp()
      for (let n = 0; ; n++) {
        const name = `${at}${n === 0 ? '' : `-${n}`}.md`
        try {
          copyFileSync(path.full, join(dir, name), constants.COPYFILE_EXCL)
          break
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 50) throw e
        }
      }
      // Oldest first, by id (so `…Z` comes before `…Z-1`, which a sort by file name gets wrong).
      const all = readdirSync(dir)
        .map((f) => f.replace(/\.md$/, ''))
        .filter((id) => BACKUP_ID.test(id))
        .sort()
      for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_PER_FILE))) rmSync(join(dir, `${old}.md`), { force: true })
    } catch (e) {
      throw new AppError('backup-failed', `lore backup failed: ${(e as Error).message}`)
    }
  }

  backups(leagueFolder: string, rel: string): LoreBackupView[] {
    const dir = backupDirOf(leagueFolder, this.safe(leagueFolder, rel).rel)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((f) => f.replace(/\.md$/, ''))
      .filter((id) => BACKUP_ID.test(id))
      .sort()
      .reverse()
      .map((id) => ({
        id,
        // 2026-10-10T08-30-00-000Z(-1) → 2026-10-10T08:30:00.000Z
        at: id.replace(/-\d+$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z'),
        size: statSync(join(dir, `${id}.md`)).size,
      }))
  }

  private backupPath(leagueFolder: string, rel: string, id: unknown): string {
    if (typeof id !== 'string' || !BACKUP_ID.test(id)) throw new AppError('invalid-input', 'bad backup id')
    const full = join(backupDirOf(leagueFolder, rel), `${id}.md`)
    if (!existsSync(full)) throw new AppError('not-found', `no backup ${id}`)
    return full
  }

  backupText(leagueFolder: string, rel: string, id: string): string {
    return this.read(this.backupPath(leagueFolder, this.safe(leagueFolder, rel).rel, id)).text
  }

  /** Puts an earlier version back, byte for byte (the current one becomes a backup itself, so this can be undone too). */
  restore(leagueFolder: string, rel: string, id: string): LoreDocView {
    const path = this.safe(leagueFolder, rel)
    const bytes = readFileSync(this.backupPath(leagueFolder, path.rel, id))
    if (!existsSync(path.full) || !readFileSync(path.full).equals(bytes)) this.write(leagueFolder, path, bytes)
    const { text, utf8 } = this.read(path.full)
    return this.view(leagueFolder, path.rel, text, utf8)
  }

  /** Takes a file out of the lore folder; it's kept under backups/lore/_deleted. */
  remove(leagueFolder: string, rel: string): void {
    const path = this.safe(leagueFolder, rel)
    if (!existsSync(path.full)) return
    const to = join(leagueFolder, 'backups', 'lore', '_deleted', `${stamp()}-${randomBytes(2).toString('hex')}`, ...path.rel.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameSync(path.full, to)
    } catch {
      copyFileSync(path.full, to)
      unlinkSync(path.full)
    }
    forgetLore(leagueFolder)
  }

  /** The full path, for showing the file in Explorer. */
  fullPath(leagueFolder: string, rel: string): string {
    const path = this.safe(leagueFolder, rel)
    if (!existsSync(path.full)) throw new AppError('not-found', `no lore file ${path.rel}`)
    return path.full
  }

  // ── Renamed players ────────────────────────────────────────────────────

  /**
   * Where each renamed player's lore file will go, worked out before anything
   * changes: his new name in the same folder (a same-name player's with his
   * first school in brackets). A target already taken by a file this batch
   * doesn't free up is a refusal, so a rename never takes another file's place.
   */
  planRenames(db: Db, leagueFolder: string, edits: PlayerEdit[]): { plans: RenamePlan[]; taken: { name: string; file: string }[] } {
    const dir = this.loreDir(leagueFolder)
    const players = listPlayers(db)
    const teams = listTeams(db)
    const history = rosterHistory(db)
    const after = new Map(players.map((p) => [p.id, p.name]))
    for (const e of edits) if (e.name !== undefined && e.name.trim() !== '' && after.has(e.playerId)) after.set(e.playerId, e.name.trim())
    const files = this.playerFiles(db, leagueFolder)
    const plans: RenamePlan[] = []
    for (const p of players) {
      const name = after.get(p.id)!
      if (name === p.name) continue
      const file = files.get(p.id)
      if (!file) continue
      const shared = players.some((o) => o.id !== p.id && after.get(o.id) === name)
      const school = teams.find((t) => t.id === (history.get(p.id)?.first ?? p.teamId))?.shortName
      plans.push({ playerId: p.id, from: file, to: `${file.split('/').slice(0, -1).join('/')}/${shared && school ? `${name}(${school})` : name}.md` })
    }
    // Files this batch moves away are free to take (two teammates swapping names); a case-only change is the same file.
    const freed = new Set(plans.map((x) => folderKey(x.from)))
    const taken: { name: string; file: string }[] = []
    for (const x of plans) {
      const there = existingLoreFile(dir, x.to)
      if (there && !freed.has(folderKey(there))) taken.push({ name: after.get(x.playerId)!, file: there })
    }
    return { plans, taken }
  }

  /**
   * Renames the planned files (and their backups) in two passes through
   * temporary names, so swaps and case-only changes work and nothing is
   * overwritten. Inside the files nothing changes, `id` included.
   */
  applyRenames(leagueFolder: string, plans: RenamePlan[]): Map<string, { from: string; to: string; status: 'moved' | 'failed' }> {
    const out = new Map<string, { from: string; to: string; status: 'moved' | 'failed' }>()
    const tag = randomBytes(4).toString('hex')
    const parked: { plan: RenamePlan; file: string; backups: string | null }[] = []
    plans.forEach((plan, i) => {
      if (plan.from === plan.to) return
      try {
        const from = this.safe(leagueFolder, plan.from)
        this.safe(leagueFolder, plan.to)
        // A name starting with '_' is skipped by the loader while it's parked, and kept by lore snapshots should a crash strand it.
        const file = join(dirname(from.full), `_renaming-${tag}-${i}.md`)
        renameSync(from.full, file)
        const backupsFrom = backupDirOf(leagueFolder, plan.from)
        let backups: string | null = null
        if (existsSync(backupsFrom)) {
          backups = `${backupsFrom}.renaming-${tag}-${i}`
          try {
            renameSync(backupsFrom, backups)
          } catch {
            backups = null
          }
        }
        parked.push({ plan, file, backups })
      } catch (e) {
        console.warn(`[lore] could not rename ${plan.from}`, e)
        out.set(plan.playerId, { from: plan.from, to: plan.to, status: 'failed' })
      }
    })
    for (const { plan, file, backups } of parked) {
      const to = this.safe(leagueFolder, plan.to)
      const back = this.safe(leagueFolder, plan.from)
      let moved = false
      try {
        if (!existingLoreFile(this.loreDir(leagueFolder), plan.to)) {
          renameSync(file, to.full)
          moved = true
        }
      } catch (e) {
        console.warn(`[lore] could not rename ${plan.from} → ${plan.to}`, e)
      }
      if (!moved) {
        try {
          renameSync(file, back.full)
        } catch (e) {
          console.warn(`[lore] could not put ${plan.from} back; it's at ${file}`, e)
        }
      }
      if (backups) {
        const dst = backupDirOf(leagueFolder, moved ? plan.to : plan.from)
        try {
          if (!existsSync(dst)) {
            mkdirSync(dirname(dst), { recursive: true })
            renameSync(backups, dst)
          } else {
            for (const f of readdirSync(backups)) if (!existsSync(join(dst, f))) renameSync(join(backups, f), join(dst, f))
          }
        } catch (e) {
          console.warn(`[lore] could not move the backups of ${plan.from}`, e)
        }
      }
      out.set(plan.playerId, { from: plan.from, to: plan.to, status: moved ? 'moved' : 'failed' })
    }
    forgetLore(leagueFolder)
    return out
  }

  /** Each player's lore file, as linked now (read before a rename, which unlinks it). */
  playerFiles(db: Db, leagueFolder: string): Map<string, string> {
    const links = linkLore(loadLoreFolder(this.loreDir(leagueFolder)).entries, loreRefs(db))
    return new Map([...links.player].map(([id, e]) => [id, e.file]))
  }

  /**
   * Lore files that point at a name (relationships, mood rules, world topics):
   * text that only you change. `bareOnly`: just the ones without a school in
   * brackets (ambiguous once two players share the name).
   */
  referencesTo(leagueFolder: string, name: string, except: string | null, bareOnly = false): string[] {
    const n = name.normalize('NFC')
    const hit = (v: unknown) => typeof v === 'string' && (v.normalize('NFC') === n || (!bareOnly && v.normalize('NFC').startsWith(`${n}(`)))
    return loadLoreFolder(this.loreDir(leagueFolder))
      .entries.filter((e) => e.file !== except)
      .filter((e) => {
        const s = e.settings as { relationships?: { with: string }[]; hooks?: { rival?: string }[]; involves?: string[] }
        return (s.relationships ?? []).some((r) => hit(r.with)) || (s.hooks ?? []).some((h) => hit(h.rival)) || (s.involves ?? []).some(hit)
      })
      .map((e) => e.file)
  }

  // ── New files ──────────────────────────────────────────────────────────

  /** The league's own template (lore/_templates), else the app's, else the smallest valid file. */
  private template(leagueFolder: string, kind: LoreKind): string {
    for (const file of [join(this.loreDir(leagueFolder), '_templates', `${kind}.md`), join(this.defaultsDir, 'lore', `${kind}.md`)]) {
      try {
        if (existsSync(file)) return readFileSync(file, 'utf8')
      } catch {
        // An unreadable template: try the next one.
      }
    }
    return FALLBACK_TEMPLATE[kind]
  }

  /** The template filled in for one file, or the fallback if a custom template wouldn't read. */
  private fill(leagueFolder: string, kind: LoreKind, rel: string, name: string): string {
    const text = this.template(leagueFolder, kind).replaceAll(PLACEHOLDER[kind], name)
    return parseLoreFile(rel, text).entry ? text : FALLBACK_TEMPLATE[kind].replaceAll(PLACEHOLDER[kind], name)
  }

  /** Where a new file goes: its team's folder as it's spelled on disk. */
  private teamFolder(leagueFolder: string, shortName: string): string {
    const teams = join(this.loreDir(leagueFolder), 'teams')
    const onDisk = existsSync(teams) ? readdirSync(teams).find((n) => n.normalize('NFC').toLowerCase() === shortName.normalize('NFC').toLowerCase()) : undefined
    return `teams/${onDisk ?? shortName}`
  }

  private prepare(db: Db, leagueFolder: string): Prepared {
    return {
      teams: listTeams(db),
      players: listPlayers(db),
      history: rosterHistory(db),
      links: linkLore(loadLoreFolder(this.loreDir(leagueFolder)).entries, loreRefs(db)),
    }
  }

  /** Makes a file from the template (or returns the one already there). */
  create(db: Db, leagueFolder: string, target: LoreCreateTarget, prepared?: Prepared): { file: string; created: boolean } {
    const { teams, players, history, links } = prepared ?? this.prepare(db, leagueFolder)
    const team = (id: string) => {
      const t = teams.find((x) => x.id === id)
      if (!t) throw new AppError('not-found', `no team ${id}`)
      return t
    }
    let rel: string
    let name: string
    let kind: LoreKind
    if (target.kind === 'player') {
      const p = players.find((x) => x.id === target.playerId)
      if (!p) throw new AppError('not-found', `no player ${target.playerId}`)
      const existing = links.player.get(p.id)
      if (existing) return { file: existing.file, created: false }
      // Same-name players carry the school they started at.
      const shared = players.some((o) => o.id !== p.id && o.name === p.name)
      const first = history.get(p.id)?.first ?? p.teamId
      name = shared ? `${p.name}(${team(first).shortName})` : p.name
      rel = `${this.teamFolder(leagueFolder, team(p.teamId).shortName)}/${name}.md`
      kind = 'player'
    } else if (target.kind === 'team' || target.kind === 'gm') {
      const t = team(target.teamId)
      const existing = (target.kind === 'team' ? links.team : links.gm).get(t.id)
      if (existing) return { file: existing.file, created: false }
      name = t.shortName
      rel = `${this.teamFolder(leagueFolder, t.shortName)}/${target.kind === 'team' ? t.shortName : `${t.shortName} 단장`}.md`
      kind = target.kind
    } else {
      const title = typeof target.title === 'string' ? target.title.trim() : ''
      if (title === '' || title.length > 60 || !isFolderSafe(title) || title.startsWith('_') || title.startsWith('.')) {
        throw new AppError('invalid-input', 'bad world title')
      }
      name = title
      rel = `world/${title}.md`
      kind = 'world'
    }
    const path = this.safe(leagueFolder, rel)
    if (existsSync(path.full)) {
      // A player's name taken by a file that reads fine is someone else's (two same-name players who started at one school).
      if (kind === 'player' && parseLoreFile(path.rel, this.read(path.full).text).entry) throw new AppError('lore-taken', `${path.rel} exists`)
      return { file: path.rel, created: false }
    }
    mkdirSync(dirname(path.full), { recursive: true })
    writeFileSync(path.full, this.fill(leagueFolder, kind, path.rel, name), { encoding: 'utf8', flag: 'wx' })
    forgetLore(leagueFolder)
    return { file: path.rel, created: true }
  }

  /** Blank files for every school, GM and player that has none. Never touches a file that exists. */
  createMissing(db: Db, leagueFolder: string): { created: number } {
    // One read of the folder for all of them: what's missing now is what gets made.
    const prepared = this.prepare(db, leagueFolder)
    let created = 0
    const make = (target: LoreCreateTarget) => {
      try {
        if (this.create(db, leagueFolder, target, prepared).created) created++
      } catch (e) {
        console.warn('[lore] could not create a file', target, e)
      }
    }
    for (const t of prepared.teams) {
      if (!prepared.links.team.has(t.id)) make({ kind: 'team', teamId: t.id })
      if (!prepared.links.gm.has(t.id)) make({ kind: 'gm', teamId: t.id })
    }
    for (const id of prepared.links.playersWithout) make({ kind: 'player', playerId: id })
    return { created }
  }
}

function sameEditable(a: LoreEditableView | null, b: LoreEditableView): boolean {
  return a !== null && sameValue(a.settings, b.settings) && sameValue(a.sections, b.sections)
}
