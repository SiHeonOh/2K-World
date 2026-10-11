import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyTeamRenames, moveTeamBackups, planTeamRenames } from './teamRename'

let root: string
let lore: string
const put = (rel: string, text = rel) => {
  mkdirSync(dirname(join(lore, rel)), { recursive: true })
  writeFileSync(join(lore, rel), text)
}
const files = (dir = lore): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '2kw-rename-'))
  lore = join(root, 'lore')
  put('teams/가람고/가람고.md')
  put('teams/가람고/가람고 단장.md')
  put('teams/가람고/김철수(가람고).md')
  put('teams/가람고/이영희.md')
  put('teams/나람고/나람고.md')
  // A same-name player who started at 가람고, now at 나람고.
  put('teams/나람고/김철수(가람고).md', 'traded')
  put('teams/나람고/김철수(나람고).md')
  put('world/라이벌.md')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('renaming a school', () => {
  it('moves its folder, its own and its GM’s files, and same-name players’ brackets; contents stay', () => {
    const plan = planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }])
    expect(plan.taken).toEqual([])
    applyTeamRenames(lore, plan)
    expect(files().sort()).toEqual(
      [
        'teams/새가람고/새가람고.md',
        'teams/새가람고/새가람고 단장.md',
        'teams/새가람고/김철수(새가람고).md',
        'teams/새가람고/이영희.md',
        'teams/나람고/나람고.md',
        'teams/나람고/김철수(새가람고).md',
        'teams/나람고/김철수(나람고).md',
        'world/라이벌.md',
      ].sort(),
    )
    expect(readFileSync(join(lore, 'teams/나람고/김철수(새가람고).md'), 'utf8')).toBe('traded')
    expect(readFileSync(join(lore, 'teams/새가람고/새가람고.md'), 'utf8')).toBe('teams/가람고/가람고.md')
  })

  it('lets two schools swap names', () => {
    const plan = planTeamRenames(lore, [
      { teamId: 't1', from: '가람고', to: '나람고' },
      { teamId: 't2', from: '나람고', to: '가람고' },
    ])
    expect(plan.taken).toEqual([])
    applyTeamRenames(lore, plan)
    expect(readFileSync(join(lore, 'teams/나람고/나람고.md'), 'utf8')).toBe('teams/가람고/가람고.md')
    expect(readFileSync(join(lore, 'teams/가람고/가람고.md'), 'utf8')).toBe('teams/나람고/나람고.md')
    // In the old 나람고 (가람고 now): the 김철수 who started at the old 가람고 names 나람고, and the other way round.
    expect(readFileSync(join(lore, 'teams/가람고/김철수(나람고).md'), 'utf8')).toBe('traded')
    expect(readFileSync(join(lore, 'teams/가람고/김철수(가람고).md'), 'utf8')).toBe('teams/나람고/김철수(나람고).md')
    expect(readFileSync(join(lore, 'teams/나람고/김철수(나람고).md'), 'utf8')).toBe('teams/가람고/김철수(가람고).md')
  })

  it('handles a change of case alone', () => {
    put('teams/Lions/Lions.md')
    applyTeamRenames(lore, planTeamRenames(lore, [{ teamId: 't9', from: 'Lions', to: 'LIONS' }]))
    expect(files().filter((f) => f.toLowerCase().includes('lions'))).toEqual(['teams/LIONS/LIONS.md'])
  })

  it('refuses a name another folder or file already has, before anything moves', () => {
    put('teams/다람고/다람고.md')
    expect(planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '다람고' }]).taken).toEqual([{ name: '다람고', path: 'teams/다람고' }])
    // A player in 나람고 already named 김철수(새가람고): the bracket rename can't take it.
    put('teams/나람고/김철수(새가람고).md')
    expect(planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }]).taken).toEqual([
      { name: '김철수(새가람고)', path: 'teams/나람고/김철수(새가람고).md' },
    ])
  })

  it('takes over a folder already under the new name when none is under the old one (a restore left it so)', () => {
    rmSync(join(lore, 'teams/가람고'), { recursive: true })
    put('teams/새가람고/새가람고.md')
    put('teams/새가람고/이영희.md')
    // A folder stranded mid-rename by a crash is left alone.
    put('teams/_renaming-0a1b2c3d-0/가람고.md')
    const plan = planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }])
    expect(plan.taken).toEqual([])
    expect(plan.folders).toEqual([])
    applyTeamRenames(lore, plan)
    // Only the bracket naming the old school moves; the folder is used as it is.
    expect(files().filter((f) => f.startsWith('teams/새가람고') || f.startsWith('teams/나람고') || f.startsWith('teams/_')).sort()).toEqual(
      [
        'teams/새가람고/새가람고.md',
        'teams/새가람고/이영희.md',
        'teams/나람고/나람고.md',
        'teams/나람고/김철수(새가람고).md',
        'teams/나람고/김철수(나람고).md',
        'teams/_renaming-0a1b2c3d-0/가람고.md',
      ].sort(),
    )
  })

  it('puts everything back when a rename fails, and undo puts back a finished one', () => {
    const plan = planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }])
    const before = files().sort()
    // A file planned to move is gone (taken by another program): the batch fails and nothing stays moved.
    rmSync(join(lore, 'teams/나람고/김철수(가람고).md'))
    expect(() => applyTeamRenames(lore, plan)).toThrow()
    expect(files().sort()).toEqual(before.filter((f) => f !== 'teams/나람고/김철수(가람고).md'))
    put('teams/나람고/김철수(가람고).md', 'traded')
    const done = applyTeamRenames(lore, planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }]))
    done.undo()
    expect(files().sort()).toEqual(before)
  })

  it('moves the files’ backups along', () => {
    const backups = join(root, 'backups', 'lore')
    mkdirSync(join(backups, 'teams/가람고/가람고'), { recursive: true })
    writeFileSync(join(backups, 'teams/가람고/가람고/2026-10-10T00-00-00-000Z.md'), 'old')
    const plan = planTeamRenames(lore, [{ teamId: 't1', from: '가람고', to: '새가람고' }])
    applyTeamRenames(lore, plan)
    moveTeamBackups(backups, plan)
    expect(existsSync(join(backups, 'teams/새가람고/새가람고/2026-10-10T00-00-00-000Z.md'))).toBe(true)
    expect(existsSync(join(backups, 'teams/가람고'))).toBe(false)
  })
})
