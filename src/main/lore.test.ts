import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { LoreEditableView } from '@shared/lore'
import { openDb, type Db } from '@data/db'
import { listPlayers, listTeams, seedLeague } from '@data/league'
import { applyTrade } from '@data/moves'
import { startSeason } from '@data/season'
import { AppError } from './errors'
import { LoreService, syncLoreFolder } from './lore'

let dir: string
let defaults: string
let db: Db
let lore: LoreService

const TEMPLATE = (kind: string) =>
  ({
    player: '---\n# 선수 템플릿\nid: 선수이름\ntraits:            # 1 ~ 5\n  ego: 3           # 자존심\nmedia: normal\n---\n\n# 선수이름\n\n## 공개\n<!-- 누구나 아는 이야기 -->\n\n## 소문\n\n## 비밀\n',
    team: '---\nid: 학교이름\nfans:\n  size: 3\n---\n\n# 학교이름\n\n## 공개\n',
    gm: '---\nid: 학교이름 단장\nteam: 학교이름\n---\n\n# 학교이름 단장\n',
    world: '---\nid: 주제이름\ntype: topic\n---\n\n# 주제이름\n',
  })[kind]!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-lore-svc-'))
  defaults = join(dir, 'defaults')
  mkdirSync(join(defaults, 'lore'), { recursive: true })
  for (const k of ['player', 'team', 'gm', 'world']) writeFileSync(join(defaults, 'lore', `${k}.md`), TEMPLATE(k))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  lore = new LoreService(defaults)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const firstPlayer = () => {
  const team = listTeams(db)[0]!
  return { team, player: listPlayers(db).find((p) => p.teamId === team.id)! }
}

const changed = (view: LoreEditableView, change: (v: LoreEditableView & { kind: 'player' }) => void): LoreEditableView => {
  const next = structuredClone(view) as LoreEditableView & { kind: 'player' }
  change(next)
  return next
}

describe('LoreService', () => {
  it('makes a file from the template, saves form edits in place with a backup, and restores', () => {
    const { team, player } = firstPlayer()
    const { file, created } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    expect(created).toBe(true)
    expect(file).toBe(`teams/${team.shortName}/${player.name}.md`)
    expect(lore.create(db, dir, { kind: 'player', playerId: player.id })).toEqual({ file, created: false })

    const doc = lore.open(dir, file)
    expect(doc.text).toContain(`id: ${player.name}`)
    expect(doc.backups).toEqual([])
    const base = doc.editable!
    const next = changed(base, (v) => {
      v.settings.traits.ego = 5
      v.sections.public = '팀의 에이스.'
    })
    const saved = lore.save(dir, { mode: 'form', file, base, next })
    if (saved.status !== 'saved') throw new Error(saved.status)
    expect(saved.merged).toBe(false)
    const text = readFileSync(join(dir, 'lore', file), 'utf8')
    expect(text).toContain('  ego: 5           # 자존심')
    expect(text).toContain('<!-- 누구나 아는 이야기 -->\n팀의 에이스.\n\n## 소문')
    expect(saved.doc.backups).toHaveLength(1)
    expect(lore.backupText(dir, file, saved.doc.backups[0]!.id)).toBe(doc.text)

    // The same edit again changes nothing (and makes no backup).
    expect(lore.save(dir, { mode: 'form', file, base, next }).status).toBe('unchanged')

    const restored = lore.restore(dir, file, saved.doc.backups[0]!.id)
    expect(restored.text).toBe(doc.text)
    expect(restored.backups).toHaveLength(2)
    expect(readFileSync(join(dir, 'lore', file), 'utf8')).toBe(doc.text)
    // No temp files left beside it.
    expect(readdirSync(join(dir, 'lore', 'teams', team.shortName)).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('merges with changes made elsewhere, and reports a clash without writing', () => {
    const { player } = firstPlayer()
    const { file } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    const base = lore.open(dir, file).editable!
    // Edited in another editor meanwhile.
    const path = join(dir, 'lore', file)
    writeFileSync(path, readFileSync(path, 'utf8').replace('## 소문\n', '## 소문\n밖에서 쓴 소문.\n'))
    const merged = lore.save(dir, { mode: 'form', file, base, next: changed(base, (v) => void (v.settings.media = 'quiet')) })
    expect(merged).toMatchObject({ status: 'saved', merged: true })
    expect(readFileSync(path, 'utf8')).toContain('밖에서 쓴 소문.')

    const before = readFileSync(path, 'utf8')
    const clash = lore.save(dir, { mode: 'form', file, base, next: changed(base, (v) => void (v.sections.rumor = '내 소문.')) })
    expect(clash).toMatchObject({ status: 'conflict', fields: ['sections.rumor'] })
    expect(readFileSync(path, 'utf8')).toBe(before)

    expect(lore.save(dir, { mode: 'form', file, base, next: changed(base, (v) => void (v.sections.public = '## 비밀\n')) })).toMatchObject({
      status: 'error',
      code: 'heading-in-text',
    })
    expect(() => lore.save(dir, { mode: 'form', file, base, next: changed(base, (v) => void (v.settings.traits.ego = 9)) })).toThrow(AppError)
  })

  it('saves raw text only over the version it was loaded from, and asks before keeping broken text', () => {
    const { player } = firstPlayer()
    const { file } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    const doc = lore.open(dir, file)
    const broken = doc.text.replace('media: normal', 'media: [')
    const invalid = lore.save(dir, { mode: 'raw', file, version: doc.version, text: broken })
    expect(invalid.status).toBe('invalid')
    expect(lore.save(dir, { mode: 'raw', file, version: doc.version, text: broken, force: true }).status).toBe('saved')
    // The form can't read it now: the raw view is all there is.
    expect(lore.open(dir, file).editable).toBeNull()
    expect(lore.save(dir, { mode: 'raw', file, version: doc.version, text: doc.text }).status).toBe('changed')
    const now = lore.open(dir, file)
    expect(lore.save(dir, { mode: 'raw', file, version: now.version, text: doc.text }).status).toBe('saved')
    expect(lore.open(dir, file).editable).not.toBeNull()
  })

  it('names same-name players by their first school, and fills in everything missing without touching what exists', () => {
    const [t1, t2] = listTeams(db)
    const a = listPlayers(db).find((p) => p.teamId === t1!.id)!
    const b = listPlayers(db).find((p) => p.teamId === t2!.id)!
    db.prepare("UPDATE players SET name = '김하람' WHERE id IN (?, ?)").run(a.id, b.id)
    const teamOf = (id: string) => listTeams(db).find((t) => t.id === listPlayers(db).find((p) => p.id === id)!.teamId)!.shortName
    expect(lore.create(db, dir, { kind: 'player', playerId: a.id }).file).toBe(`teams/${teamOf(a.id)}/김하람(${teamOf(a.id)}).md`)
    expect(lore.open(dir, `teams/${teamOf(a.id)}/김하람(${teamOf(a.id)}).md`).editable!.settings.id).toBe(`김하람(${teamOf(a.id)})`)
    // A third 김하람 who started at a's school can't be told apart by file name.
    const c = listPlayers(db).find((p) => p.teamId === t1!.id && p.id !== a.id)!
    db.prepare("UPDATE players SET name = '김하람' WHERE id = ?").run(c.id)
    expect(() => lore.create(db, dir, { kind: 'player', playerId: c.id })).toThrow(expect.objectContaining({ code: 'lore-taken' }))
    db.prepare("UPDATE players SET name = '김삼우' WHERE id = ?").run(c.id)

    const team = listTeams(db)[0]!
    const gm = lore.create(db, dir, { kind: 'gm', teamId: team.id })
    expect(gm.file).toBe(`teams/${team.shortName}/${team.shortName} 단장.md`)
    expect(lore.open(dir, gm.file).editable).toMatchObject({ kind: 'gm', settings: { team: team.shortName } })
    writeFileSync(join(dir, 'lore', gm.file), lore.open(dir, gm.file).text + '\n내가 쓴 글.\n')

    const { created } = lore.createMissing(db, dir)
    const players = listPlayers(db).length
    const teams = listTeams(db).length
    // Every team file, every other GM file, every player but the one made above.
    expect(created).toBe(teams + (teams - 1) + (players - 1))
    expect(readFileSync(join(dir, 'lore', gm.file), 'utf8')).toContain('내가 쓴 글.')
    expect(lore.createMissing(db, dir).created).toBe(0)
    const index = lore.index(db, dir)
    expect(index.missing).toEqual([])
    expect(index.missingTeams).toEqual([])
    expect(index.missingGms).toEqual([])

    expect(lore.create(db, dir, { kind: 'world', title: '전국대회 결승' }).file).toBe('world/전국대회 결승.md')
    for (const title of ['', '../x', 'a/b', '_x', 'con']) expect(() => lore.create(db, dir, { kind: 'world', title })).toThrow(AppError)
  })

  it('uses the league’s own template first', () => {
    mkdirSync(join(dir, 'lore', '_templates'), { recursive: true })
    writeFileSync(join(dir, 'lore', '_templates', 'world.md'), '---\nid: 주제이름\ntype: event\n---\n# 주제이름 (리그 템플릿)\n')
    const { file } = lore.create(db, dir, { kind: 'world', title: '첫 경기' })
    expect(lore.open(dir, file).text).toContain('# 첫 경기 (리그 템플릿)')
    // A template that doesn't read is replaced by the smallest valid file.
    writeFileSync(join(dir, 'lore', '_templates', 'world.md'), '---\nid: [\n---\n')
    expect(lore.open(dir, lore.create(db, dir, { kind: 'world', title: '둘째 경기' }).file).editable).not.toBeNull()
  })

  it('touches nothing outside teams/<학교>/ and world/', () => {
    for (const bad of ['../league.db', 'teams/../../x.md', 'teams/a/b/c.md', '_templates/player.md', 'teams/_x/a.md', 'C:/x.md', 'world/a.txt', 'world/.hidden.md']) {
      expect(() => lore.open(dir, bad)).toThrow(AppError)
      expect(() => lore.remove(dir, bad)).toThrow(AppError)
    }
  })

  it('removes a file into backups, where it can be found again', () => {
    const { player } = firstPlayer()
    const { file } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    lore.remove(dir, file)
    expect(existsSync(join(dir, 'lore', file))).toBe(false)
    const deleted = join(dir, 'backups', 'lore', '_deleted')
    const [stamp] = readdirSync(deleted)
    expect(existsSync(join(deleted, stamp!, ...file.split('/')))).toBe(true)
    expect(lore.save(dir, { mode: 'raw', file, version: '', text: '' })).toEqual({ status: 'gone' })
  })

  it('never saves over a file that isn’t UTF-8, and backs up byte for byte', () => {
    const { player } = firstPlayer()
    const { file } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    const path = join(dir, 'lore', file)
    // Old Notepad (CP949): "슈터" is C2 B4 C5 CD.
    const cp949 = Buffer.concat([Buffer.from(readFileSync(path, 'utf8').replace('## 공개\n', '## 공개\n'), 'utf8'), Buffer.from([0xc2, 0xb4, 0xc5, 0xcd, 0x0a])])
    writeFileSync(path, cp949)
    const doc = lore.open(dir, file)
    expect(doc.utf8).toBe(false)
    const next = changed(doc.editable!, (v) => void (v.settings.traits.ego = 5))
    expect(lore.save(dir, { mode: 'form', file, base: doc.editable!, next })).toEqual({ status: 'error', code: 'not-utf8', detail: '' })
    expect(readFileSync(path).equals(cp949)).toBe(true)

    // A UTF-8 file with a BOM and Windows line endings: the backup is the exact bytes.
    const original = Buffer.from(`﻿${TEMPLATE('player').replaceAll('선수이름', player.name).replace(/\n/g, '\r\n')}`, 'utf8')
    writeFileSync(path, original)
    const fresh = lore.open(dir, file)
    expect(fresh.utf8).toBe(true)
    const saved = lore.save(dir, { mode: 'form', file, base: fresh.editable!, next: changed(fresh.editable!, (v) => void (v.settings.traits.ego = 5)) })
    if (saved.status !== 'saved') throw new Error(saved.status)
    const backup = join(dir, 'backups', 'lore', ...file.replace(/\.md$/, '').split('/'), `${saved.doc.backups[0]!.id}.md`)
    expect(readFileSync(backup).equals(original)).toBe(true)
    expect(readFileSync(path, 'utf8').startsWith('﻿---\r\n')).toBe(true)
  })

  it('carries a file’s backups along when a trade moves it', () => {
    const { team, player } = firstPlayer()
    const other = listTeams(db)[1]!
    const partner = listPlayers(db).find((p) => p.teamId === other.id && p.slotId === player.slotId)!
    const { file } = lore.create(db, dir, { kind: 'player', playerId: player.id })
    const doc = lore.open(dir, file)
    lore.save(dir, { mode: 'form', file, base: doc.editable!, next: changed(doc.editable!, (v) => void (v.settings.media = 'quiet')) })
    startSeason(db)
    applyTrade(db, [
      { kind: 'player', playerId: player.id, from: team.id, to: other.id },
      { kind: 'player', playerId: partner.id, from: other.id, to: team.id },
    ])
    expect(syncLoreFolder(db, dir).moved).toEqual([{ from: file, to: `teams/${other.shortName}/${player.name}.md` }])
    expect(lore.open(dir, `teams/${other.shortName}/${player.name}.md`).backups).toHaveLength(1)
  })

  it('refuses a path that leaves the lore folder through a link inside it', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'a.md'), '---\nid: a\n---\n')
    mkdirSync(join(dir, 'lore', 'teams'), { recursive: true })
    symlinkSync(outside, join(dir, 'lore', 'teams', '바깥'), 'junction')
    expect(() => lore.open(dir, 'teams/바깥/a.md')).toThrow(AppError)
    expect(() => lore.remove(dir, 'teams/바깥/a.md')).toThrow(AppError)
    expect(existsSync(join(outside, 'a.md'))).toBe(true)
  })
})
