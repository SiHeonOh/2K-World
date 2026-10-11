import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { createContext, type AppContext } from './context'
import { AppError } from './errors'
import { createHandlers, type HandlerDeps } from './handlers'
import { DELETED_DIR } from './leagues'

let root: string
let ctx: AppContext
let opened: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '2kw-remove-'))
  mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
  ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0.0.0-test')
  opened = []
})
afterEach(() => {
  ctx.ai.closeAll()
  ctx.leagues.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const deps = (): HandlerDeps => ({
  context: () => ctx,
  appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
  pickFile: async () => null,
  pickFolder: async () => null,
  openFolder: (path) => void opened.push(path),
  showItem: () => {},
  switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
})

const code = async (p: () => unknown) => {
  try {
    await p()
  } catch (e) {
    return e instanceof AppError ? e.code : String(e)
  }
  return 'no-error'
}

describe('deleting a league', () => {
  it('moves the whole folder to _deleted, off the list, and the same name can be made again', async () => {
    const h = createHandlers(deps())
    ctx.leagues.create({ slug: 'old', setup: sampleSetup(), saveTemplate: null, importMapping: null })
    ctx.leagues.create({ slug: 'keep', setup: sampleSetup(), saveTemplate: null, importMapping: null })
    // Open (with its AI queue running) when it's deleted, with a file of lore of its own.
    await h['season.start']('old')
    mkdirSync(join(ctx.dataDir, 'old', 'lore', 'world'), { recursive: true })
    writeFileSync(join(ctx.dataDir, 'old', 'lore', 'world', '역사.md'), '# 역사\n')
    expect((await h['leagues.list']()).map((l) => l.slug)).toEqual(['keep', 'old'])

    const { movedTo } = await h['leagues.remove']('old')
    expect(movedTo).toMatch(/^_deleted\/\d{4}-\d{2}-\d{2}_\d{6}-old$/)
    expect(existsSync(join(ctx.dataDir, 'old'))).toBe(false)
    const kept = join(ctx.dataDir, movedTo)
    // Everything went along: the database and the lore.
    expect(existsSync(join(kept, 'league.sqlite'))).toBe(true)
    expect(existsSync(join(kept, 'lore', 'world', '역사.md'))).toBe(true)
    expect((await h['leagues.list']()).map((l) => l.slug)).toEqual(['keep'])

    // The folder name is free again, and the other league is untouched.
    ctx.leagues.create({ slug: 'old', setup: sampleSetup(), saveTemplate: null, importMapping: null })
    expect((await h['season.standings']('old')).played).toBe(0)
    expect((await h['leagues.snapshot']('keep')).slug).toBe('keep')

    // A second delete of the same name lands beside the first.
    await h['leagues.remove']('old')
    expect(readdirSync(join(ctx.dataDir, DELETED_DIR)).filter((n) => n.endsWith('-old') || /-old-\d+$/.test(n))).toHaveLength(2)

    await h['leagues.openDeleted']()
    expect(opened).toEqual([join(ctx.dataDir, DELETED_DIR)])
  })

  it('takes a folder with only lore, and refuses names that aren\'t league folders', async () => {
    const h = createHandlers(deps())
    mkdirSync(join(ctx.dataDir, 'loreonly', 'lore'), { recursive: true })
    expect((await h['leagues.list']()).map((l) => l.slug)).toEqual(['loreonly'])
    await h['leagues.remove']('loreonly')
    expect(await h['leagues.list']()).toEqual([])

    expect(await code(() => h['leagues.remove']('nothing-here'))).toBe('not-found')
    for (const bad of ['../data', '_deleted', 'templates', 'a/b', '']) expect(await code(() => h['leagues.remove'](bad))).not.toBe('no-error')
    // Nothing outside the data folder moved.
    expect(existsSync(join(root, 'defaults', 'templates'))).toBe(true)
  })

  it('finds the folder whatever the case, as Windows does', async () => {
    const h = createHandlers(deps())
    ctx.leagues.create({ slug: 'Inter', setup: sampleSetup(), saveTemplate: null, importMapping: null })
    const { movedTo } = await h['leagues.remove']('inter')
    expect(movedTo.endsWith('-Inter')).toBe(true)
    expect(await h['leagues.list']()).toEqual([])
  })
})
