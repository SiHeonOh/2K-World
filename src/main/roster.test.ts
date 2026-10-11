import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { listPlayers, listTeams, loadConfig, seedLeague } from '@data/league'
import { pageByRef, pageByTitle, saveRevision } from '@data/wiki'
import { seedWiki } from '@story/wiki'
import { linkLore, loadLoreFolder } from '@lore/folder'
import { loreRefs } from '@story/context'
import { LoreService } from './lore'
import { editRoster } from './roster'

let dir: string
let db: Db
let lore: LoreService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-roster-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  lore = new LoreService(join(dir, 'defaults'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('renaming a player', () => {
  it('takes his lore file, its backups and his wiki page along, and reports what still uses the old name', () => {
    const team = listTeams(db)[0]!
    const [a, b] = listPlayers(db).filter((p) => p.teamId === team.id)
    const folder = join(dir, 'lore', 'teams', team.shortName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${a!.name}.md`), `---\nid: ${a!.name}\n---\n## 공개\n에이스.\n`)
    writeFileSync(join(folder, `${b!.name}.md`), `---\nid: ${b!.name}\nrelationships:\n  - with: ${a!.name}\n    type: friend\n    strength: 4\n    visibility: public\n---\n`)
    // A save, so there's a backup to carry along.
    const doc = lore.open(dir, `teams/${team.shortName}/${a!.name}.md`)
    lore.save(dir, { mode: 'form', file: doc.file, base: doc.editable!, next: { ...doc.editable!, sections: { ...doc.editable!.sections, rumor: '소문.' } } })
    seedWiki(db, loadConfig(db).config, linkLore(loadLoreFolder(join(dir, 'lore')).entries, loreRefs(db)), Date.now())
    saveRevision(db, { title: '위키 메모', kind: 'page', refId: null, body: `[[${a!.name}]] 이야기.`, authorId: 'me', summary: '' }, Date.now())

    const result = editRoster(db, dir, lore, [{ playerId: a!.id, name: '새이름' }])
    expect(result.changed).toBe(1)
    const [r] = result.renamed
    expect(r).toMatchObject({
      from: a!.name,
      to: '새이름',
      lore: { from: `teams/${team.shortName}/${a!.name}.md`, to: `teams/${team.shortName}/새이름.md`, status: 'moved' },
      wikiTitle: '새이름',
      loreReferences: [`teams/${team.shortName}/${b!.name}.md`],
      wikiLinks: 1,
      sharedName: false,
      ambiguousReferences: [],
    })
    expect(readFileSync(join(folder, '새이름.md'), 'utf8')).toContain(`id: ${a!.name}`)
    expect(existsSync(join(folder, `${a!.name}.md`))).toBe(false)
    expect(lore.open(dir, `teams/${team.shortName}/새이름.md`).backups).toHaveLength(1)
    expect(pageByRef(db, 'player', a!.id)!.title).toBe('새이름')
    expect(pageByTitle(db, a!.name)).toBeNull()
    // Still linked: his lore keeps being used.
    expect(linkLore(loadLoreFolder(join(dir, 'lore')).entries, loreRefs(db)).player.get(a!.id)?.file).toBe(`teams/${team.shortName}/새이름.md`)
  })

  it('refuses a new name another file already has there, changing nothing', () => {
    const team = listTeams(db)[0]!
    const [a] = listPlayers(db).filter((p) => p.teamId === team.id)
    const folder = join(dir, 'lore', 'teams', team.shortName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${a!.name}.md`), `---\nid: ${a!.name}\n---\n`)
    writeFileSync(join(folder, '새이름.md'), '---\nid: 다른 사람\n---\n')
    expect(() => editRoster(db, dir, lore, [{ playerId: a!.id, name: '새이름' }])).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ code: 'roster-lore-taken' })] }))
    expect(listPlayers(db).find((p) => p.id === a!.id)!.name).toBe(a!.name)
    expect(readFileSync(join(folder, '새이름.md'), 'utf8')).toContain('다른 사람')
    expect(readFileSync(join(folder, `${a!.name}.md`), 'utf8')).toContain(`id: ${a!.name}`)
  })

  it('swaps two teammates’ names with their own lore and wiki pages, and changes only a name’s case', () => {
    const team = listTeams(db)[0]!
    const [a, b] = listPlayers(db).filter((p) => p.teamId === team.id)
    const folder = join(dir, 'lore', 'teams', team.shortName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${a!.name}.md`), `---\nid: ${a!.name}\n---\n## 공개\na의 이야기.\n`)
    writeFileSync(join(folder, `${b!.name}.md`), `---\nid: ${b!.name}\n---\n## 공개\nb의 이야기.\n`)
    seedWiki(db, loadConfig(db).config, linkLore(loadLoreFolder(join(dir, 'lore')).entries, loreRefs(db)), Date.now())
    const result = editRoster(db, dir, lore, [
      { playerId: a!.id, name: b!.name },
      { playerId: b!.id, name: a!.name },
    ])
    expect(result.renamed.map((r) => r.lore?.status)).toEqual(['moved', 'moved'])
    const links = linkLore(loadLoreFolder(join(dir, 'lore')).entries, loreRefs(db))
    expect(links.player.get(a!.id)?.sections.public).toBe('a의 이야기.')
    expect(links.player.get(b!.id)?.sections.public).toBe('b의 이야기.')
    expect(pageByRef(db, 'player', a!.id)!.title).toBe(b!.name)
    expect(pageByRef(db, 'player', b!.id)!.title).toBe(a!.name)

    // Latin letters: a change of case only.
    editRoster(db, dir, lore, [{ playerId: a!.id, name: 'Kim Lee' }])
    const cased = editRoster(db, dir, lore, [{ playerId: a!.id, name: 'KIM LEE' }])
    expect(cased.renamed[0]!.lore).toMatchObject({ to: `teams/${team.shortName}/KIM LEE.md`, status: 'moved' })
    expect(linkLore(loadLoreFolder(join(dir, 'lore')).entries, loreRefs(db)).player.get(a!.id)?.sections.public).toBe('a의 이야기.')
  })

  it('tells you when a new name is now shared, and which lore names it without a school', () => {
    const [t1, t2] = listTeams(db)
    const a = listPlayers(db).find((p) => p.teamId === t1!.id)!
    const other = listPlayers(db).find((p) => p.teamId === t2!.id)!
    const folder = join(dir, 'lore', 'teams', t1!.shortName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${a.name}.md`), `---\nid: ${a.name}\nrelationships:\n  - with: ${other.name}\n    type: rival\n    strength: 3\n    visibility: public\n---\n`)
    const [r] = editRoster(db, dir, lore, [{ playerId: a.id, name: other.name }]).renamed
    expect(r).toMatchObject({ sharedName: true, lore: { to: `teams/${t1!.shortName}/${other.name}(${t1!.shortName}).md`, status: 'moved' } })
    // His own file names the other one bare: that's his, so it isn't listed; nothing else does.
    expect(r!.ambiguousReferences).toEqual([])
  })
})
