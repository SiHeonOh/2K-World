import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listLoreSnapshots, loreKeepFor, pruneLoreSnapshots, restoreLoreSnapshot, snapshotLore, snapshotsDir } from './loreSnapshots'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-loresnap-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (rel: string, text: string) => {
  const file = join(dir, 'lore', ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (rel: string) => readFileSync(join(dir, 'lore', ...rel.split('/')), 'utf8')
const T0 = new Date(2026, 9, 11, 9, 0, 0).getTime()
const HOUR = 3_600_000

describe('lore snapshots', () => {
  it('copy the lore files (not editor temp files or vault settings), and skip an unchanged folder', () => {
    write('teams/가람고/가가가.md', '# 가가가')
    write('world/설정.md', '세계관')
    write('teams/가람고/.가가가.md.tmp', '저장 중')
    write('.obsidian/app.json', '{}')
    // A school's folder stranded mid-rename by a crash is still lore to keep.
    write('teams/_renaming-0a1b2c3d-0/나람고.md', '# 나람고')
    const id = snapshotLore(dir, 'season-start', T0)!
    expect(id).toMatch(/-season-start$/)
    const copy = join(snapshotsDir(dir), id, 'lore')
    expect(readFileSync(join(copy, 'teams', '가람고', '가가가.md'), 'utf8')).toBe('# 가가가')
    expect(existsSync(join(copy, '.obsidian'))).toBe(false)
    expect(existsSync(join(copy, 'teams', '가람고', '.가가가.md.tmp'))).toBe(false)
    expect(readFileSync(join(copy, 'teams', '_renaming-0a1b2c3d-0', '나람고.md'), 'utf8')).toBe('# 나람고')
    expect(listLoreSnapshots(dir)).toEqual([{ id, at: new Date(T0).toISOString(), reason: 'season-start', files: 3, bytes: 31, keep: 20 }])

    // Nothing changed: no second copy for the same step; yours always.
    expect(snapshotLore(dir, 'season-start', T0 + HOUR)).toBeNull()
    expect(snapshotLore(dir, 'manual', T0 + HOUR)).not.toBeNull()
    expect(snapshotLore(dir, 'manual', T0 + 2 * HOUR)).not.toBeNull()
    write('world/설정.md', '세계관 2')
    expect(snapshotLore(dir, 'season-start', T0 + 3 * HOUR)).not.toBeNull()
  })

  it('takes the opening snapshot once a day', () => {
    write('world/설정.md', '1')
    expect(snapshotLore(dir, 'open', T0)).not.toBeNull()
    write('world/설정.md', '2')
    expect(snapshotLore(dir, 'open', T0 + 2 * HOUR)).toBeNull()
    expect(snapshotLore(dir, 'open', T0 + 24 * HOUR)).not.toBeNull()
  })

  it('is nothing without a lore folder', () => {
    expect(snapshotLore(dir, 'manual', T0)).toBeNull()
    expect(listLoreSnapshots(dir)).toEqual([])
  })

  it('prunes each kind by itself, never yours, and clears half-made copies', () => {
    for (let i = 0; i < 14; i++) {
      write('world/설정.md', `open ${i}`)
      snapshotLore(dir, 'open', T0 + i * 24 * HOUR)
    }
    for (let i = 0; i < 12; i++) snapshotLore(dir, 'manual', T0 + i * HOUR)
    mkdirSync(join(snapshotsDir(dir), '2026-01-01T00-00-00-000Z-open.partial'), { recursive: true })
    pruneLoreSnapshots(dir, 'open')
    pruneLoreSnapshots(dir, 'manual')
    const list = listLoreSnapshots(dir)
    expect(list.filter((s) => s.reason === 'open')).toHaveLength(loreKeepFor('open')!)
    expect(list.filter((s) => s.reason === 'manual')).toHaveLength(12)
    expect(readdirSync(snapshotsDir(dir)).some((n) => n.endsWith('.partial'))).toBe(false)
  })

  it('restores a snapshot in place of the folder, after snapshotting the folder as it is', () => {
    write('teams/가람고/가가가.md', '처음')
    const id = snapshotLore(dir, 'manual', T0)!
    write('teams/가람고/가가가.md', '고친 글')
    write('teams/가람고/새선수.md', '새 파일')
    write('.obsidian/app.json', '{"vault":true}')

    const { safety } = restoreLoreSnapshot(dir, id, T0 + HOUR)
    expect(read('teams/가람고/가가가.md')).toBe('처음')
    expect(existsSync(join(dir, 'lore', 'teams', '가람고', '새선수.md'))).toBe(false)
    // A vault's settings stay with the folder.
    expect(read('.obsidian/app.json')).toBe('{"vault":true}')
    // What was replaced is a snapshot of its own, so this can be undone the same way.
    expect(safety).toMatch(/-before-restore$/)
    const back = join(snapshotsDir(dir), safety!, 'lore', 'teams', '가람고')
    expect(readFileSync(join(back, '가가가.md'), 'utf8')).toBe('고친 글')
    expect(readFileSync(join(back, '새선수.md'), 'utf8')).toBe('새 파일')
    expect(readdirSync(dir).filter((n) => n.startsWith('lore.'))).toEqual([])

    restoreLoreSnapshot(dir, safety!, T0 + 2 * HOUR)
    expect(read('teams/가람고/가가가.md')).toBe('고친 글')
    expect(read('teams/가람고/새선수.md')).toBe('새 파일')
  })

  it('refuses a name that isn’t one of its snapshots', () => {
    write('world/설정.md', '1')
    for (const bad of ['..', '../lore', 'nope', '2026-01-01T00-00-00-000Z-manual']) {
      expect(() => restoreLoreSnapshot(dir, bad)).toThrow()
    }
    expect(read('world/설정.md')).toBe('1')
  })

  it('keeps the before-restore snapshot when the clock is behind the older ones', () => {
    write('teams/가람고/가람고.md', '처음')
    const old = snapshotLore(dir, 'manual', T0)!
    // Ten restores while the PC's clock ran two months ahead; then it was put right.
    const ahead = T0 + 60 * 24 * HOUR
    for (let i = 0; i < 10; i++) {
      write('teams/가람고/가람고.md', `ahead ${i}`)
      snapshotLore(dir, 'before-restore', ahead + i * 1000)
    }
    write('teams/가람고/가람고.md', '마지막 작업')
    const { safety } = restoreLoreSnapshot(dir, old, T0 + HOUR)
    expect(read('teams/가람고/가람고.md')).toBe('처음')
    expect(readFileSync(join(snapshotsDir(dir), safety!, 'lore', 'teams', '가람고', '가람고.md'), 'utf8')).toBe('마지막 작업')
    expect(listLoreSnapshots(dir).filter((s) => s.reason === 'before-restore')).toHaveLength(loreKeepFor('before-restore')!)
  })

  it('moves what snapshots skip into the restored folder at any depth: hidden notes, hidden folders, links', () => {
    write('teams/가람고/가람고.md', 'v1')
    write('.obsidian/app.json', '{}')
    const id = snapshotLore(dir, 'manual', T0)!
    // Later: a hidden note beside a school's files, hidden drafts in a folder the snapshot never had, and a link to a folder outside.
    write('teams/가람고/.메모.md', '혼자 보는 메모')
    write('world/.drafts/초안.md', '초안')
    const shared = join(dir, 'shared')
    mkdirSync(shared)
    writeFileSync(join(shared, 'keep.md'), '밖에 있는 파일')
    symlinkSync(shared, join(dir, 'lore', 'teams', '가람고', 'linked'), 'junction')

    const { safety, kept } = restoreLoreSnapshot(dir, id, T0 + HOUR)
    expect(read('teams/가람고/가람고.md')).toBe('v1')
    expect(read('teams/가람고/.메모.md')).toBe('혼자 보는 메모')
    expect(read('world/.drafts/초안.md')).toBe('초안')
    expect(read('.obsidian/app.json')).toBe('{}')
    expect(lstatSync(join(dir, 'lore', 'teams', '가람고', 'linked')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(shared, 'keep.md'), 'utf8')).toBe('밖에 있는 파일')
    // Everything else was in the snapshot, so the replaced folder went.
    expect(kept).toBeNull()
    expect(safety).not.toBeNull()
    expect(readdirSync(dir).filter((n) => n.startsWith('lore.'))).toEqual([])
  })

  it('keeps the replaced folder, and says where, when something in it can’t move', () => {
    write('world/메모', '파일이던 때')
    const id = snapshotLore(dir, 'manual', T0)!
    // Later the file became a folder holding a hidden note: the restored folder has a file by that name.
    rmSync(join(dir, 'lore', 'world', '메모'))
    write('world/메모/.비밀.md', '하나뿐인 사본')
    const { kept } = restoreLoreSnapshot(dir, id, T0 + HOUR)
    expect(read('world/메모')).toBe('파일이던 때')
    expect(kept).not.toBeNull()
    expect(readFileSync(join(kept!, 'world', '메모', '.비밀.md'), 'utf8')).toBe('하나뿐인 사본')
  })

  it('refuses a lore folder that is a link to a vault elsewhere, changing nothing', () => {
    const vault = join(dir, 'MyVault')
    mkdirSync(join(vault, 'teams', 'A'), { recursive: true })
    mkdirSync(join(vault, '.obsidian'))
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{}')
    writeFileSync(join(vault, 'teams', 'A', 'A.md'), 'v0')
    const league = join(dir, 'league')
    mkdirSync(league)
    symlinkSync(vault, join(league, 'lore'), 'junction')
    const id = snapshotLore(league, 'manual', T0)!
    writeFileSync(join(vault, 'teams', 'A', 'A.md'), 'v1')
    expect(() => restoreLoreSnapshot(league, id, T0 + HOUR)).toThrow(/lore-linked/)
    expect(lstatSync(join(league, 'lore')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(vault, 'teams', 'A', 'A.md'), 'utf8')).toBe('v1')
    expect(existsSync(join(vault, '.obsidian', 'app.json'))).toBe(true)
  })
})
