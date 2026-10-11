import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { settingsOf, type LeagueSettingsInput } from '@shared/settings'
import { listTeams, loadConfig } from '@data/league'
import { pageByRef, revisionBody } from '@data/wiki'
import { startSeason } from '@data/season'
import { linkLore, loadLoreFolder } from '@lore/folder'
import { loreRefs } from '@story/context'
import { createContext, type AppContext } from './context'
import { AppError } from './errors'
import { createHandlers, type HandlerDeps } from './handlers'

let root: string
let ctx: AppContext
const slug = 'settings-league'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '2kw-settings-'))
  mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
  ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0.0.0-test')
  const setup = sampleSetup()
  setup.config.draft = defaultCardSwap(8)
  ctx.leagues.create({ slug, setup, saveTemplate: null, importMapping: null })
})
afterEach(() => {
  ctx.ai.closeAll()
  ctx.leagues.closeAll()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const deps = (): HandlerDeps => ({
  context: () => ctx,
  appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
  pickFile: async () => null,
  pickFolder: async () => null,
  openFolder: () => {},
  showItem: () => {},
  switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
})
const folder = () => ctx.leagues.folderOf(slug)
const input = (): LeagueSettingsInput => {
  const db = ctx.leagues.dbFor(slug)
  return structuredClone(settingsOf(loadConfig(db).config, listTeams(db)))
}
const failure = async (fn: () => unknown) => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof AppError) return e.toShape()
    throw e
  }
  throw new Error('not refused')
}
const lore = (rel: string, text: string) => {
  const path = join(folder(), 'lore', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('리그 설정 (handlers)', () => {
  it('renames a school: backup first, its lore folder moves with it, and its players’ wiki pages follow', async () => {
    const h = createHandlers(deps())
    lore('teams/가람고/가람고.md', '---\nid: 가람고\n---\n\n# 가람고\n\n## 공개\n산 아래 학교.\n')
    lore('teams/가람고/가람고 단장.md', '---\nid: 가람고 단장\nteam: 가람고\n---\n\n# 가람고 단장\n\n## 공개\n')
    lore('teams/가람고/가가가.md', '---\nid: 가가가\n---\n\n# 가가가\n\n## 공개\n')
    // The wiki files 가람고's players under it.
    ctx.wiki.ensure(ctx.leagues.dbFor(slug), folder(), true)
    const db = ctx.leagues.dbFor(slug)
    expect(revisionBody(db, pageByRef(db, 'player', 'p1')!.id, pageByRef(db, 'player', 'p1')!.currentRev!)!.body).toContain('[[분류:가람고 선수]]')

    const next = input()
    next.teams[0]!.shortName = '새가람고'
    next.teams[0]!.name = '새가람고등학교'
    const r = await h['leagues.saveSettings'](slug, next)
    expect(r).toMatchObject({ version: null, changed: ['teams'], renamed: [{ teamId: 't1', from: '가람고', to: '새가람고' }], loreMoved: 3, wikiUpdated: 6 })
    expect(readdirSync(join(folder(), 'backups')).some((f) => f.includes('-settings-'))).toBe(true)
    expect(readdirSync(join(folder(), 'lore', 'teams', '새가람고')).sort()).toEqual(['가가가.md', '새가람고 단장.md', '새가람고.md'])
    expect(existsSync(join(folder(), 'lore', 'teams', '가람고'))).toBe(false)
    // Still linked, contents untouched.
    const links = linkLore(loadLoreFolder(join(folder(), 'lore')).entries, loreRefs(db))
    expect(links.team.get('t1')?.sections.public).toBe('산 아래 학교.')
    expect(links.gm.has('t1')).toBe(true)
    expect(links.player.has('p1')).toBe(true)
    expect(readFileSync(join(folder(), 'lore', 'teams', '새가람고', '새가람고.md'), 'utf8')).toContain('id: 가람고')
    // The page keeps its title (links to it keep working); its players are filed under the new name.
    const page = pageByRef(db, 'player', 'p1')!
    const body = revisionBody(db, page.id, page.currentRev!)!.body
    expect(body).toContain('[[분류:새가람고 선수]]')
    expect(body).not.toContain('[[분류:가람고 선수]]')
    expect(pageByRef(db, 'team', 't1')!.title).toBe('가람고')
  })

  it('refuses a rename whose lore folder another folder holds, changing nothing', async () => {
    const h = createHandlers(deps())
    lore('teams/가람고/가람고.md', '---\nid: 가람고\n---\n')
    lore('teams/옛학교/옛학교.md', '---\nid: 옛학교\n---\n')
    const next = input()
    next.teams[0]!.shortName = '옛학교'
    expect(await failure(() => h['leagues.saveSettings'](slug, next))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'settings-team-lore-taken', params: { name: '옛학교', path: 'teams/옛학교' } }],
    })
    expect(listTeams(ctx.leagues.dbFor(slug))[0]!.shortName).toBe('가람고')
    expect(existsSync(join(folder(), 'lore', 'teams', '가람고', '가람고.md'))).toBe(true)
  })

  it('explains refusals: a section whose time has passed as a rule, a broken setup as the wizard’s issues', async () => {
    const h = createHandlers(deps())
    startSeason(ctx.leagues.dbFor(slug))
    const late = input()
    late.schedule = { kind: 'round-robin', cycles: 2, build: 'auto' }
    expect(await failure(() => h['leagues.saveSettings'](slug, late))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'settings-season-running', params: { phase: 'regular', section: 'schedule' } }],
    })
    const broken = input()
    broken.teams[1]!.shortName = broken.teams[0]!.shortName
    expect(await failure(() => h['leagues.saveSettings'](slug, broken))).toMatchObject({ code: 'invalid-setup', issues: [{ code: 'duplicate-name' }] })
    expect(await failure(() => h['leagues.saveSettings'](slug, { ...input(), teams: 'nope' }))).toMatchObject({ code: 'invalid-input' })
    // What's open now, for the screen.
    expect(await h['leagues.settingsState'](slug)).toMatchObject({ phase: 'regular', issuedCards: 3, locks: { teams: { open: true }, structure: { open: false } } })
  })

  it('takes over a school folder already under the new name when none is under the old one', async () => {
    const h = createHandlers(deps())
    // As a restore can leave it: the league says 가람고, its lore is under 새가람고.
    lore('teams/새가람고/새가람고.md', '---\nid: 새가람고\n---\n')
    lore('teams/새가람고/가가가.md', '---\nid: 가가가\n---\n')
    const next = input()
    next.teams[0]!.shortName = '새가람고'
    expect(await h['leagues.saveSettings'](slug, next)).toMatchObject({ renamed: [{ from: '가람고', to: '새가람고' }], loreMoved: 0 })
    const links = linkLore(loadLoreFolder(join(folder(), 'lore')).entries, loreRefs(ctx.leagues.dbFor(slug)))
    expect(links.team.has('t1')).toBe(true)
    expect(links.player.has('p1')).toBe(true)
  })

  it('switching the card draft off makes a fresh backup, even right after another settings save', async () => {
    const h = createHandlers(deps())
    const db = ctx.leagues.dbFor(slug)
    // A card carried over into this preseason.
    db.prepare("INSERT INTO cards (season_id, issued_season_id, original_team_id, owner_team_id, number, status) VALUES (1, 1, 't1', 't1', 1, 'held')").run()
    expect(await h['leagues.settingsState'](slug)).toMatchObject({ heldCards: 1 })
    const settingsCopies = () => readdirSync(join(folder(), 'backups')).filter((f) => f.includes('-settings-')).length
    const colors = input()
    colors.teams[0]!.colors = ['#112233']
    await h['leagues.saveSettings'](slug, colors)
    expect(settingsCopies()).toBe(1)
    const off = input()
    off.draft = { kind: 'none' }
    expect(await h['leagues.saveSettings'](slug, off)).toMatchObject({ cardsExpired: 1 })
    expect(settingsCopies()).toBe(2)
  })
})

describe('restores and renamed schools', () => {
  it('puts a school’s lore folder under the name the restored league or the league now has', async () => {
    const h = createHandlers(deps())
    lore('teams/가람고/가람고.md', '---\nid: 가람고\n---\n\n# 가람고\n\n## 공개\n산 아래 학교.\n')
    lore('teams/가람고/가람고 단장.md', '---\nid: 가람고 단장\nteam: 가람고\n---\n')
    lore('teams/가람고/가가가.md', '---\nid: 가가가\n---\n')
    const school = (name: string) => (existsSync(join(folder(), 'lore', 'teams', name)) ? readdirSync(join(folder(), 'lore', 'teams', name)).sort() : null)
    // 지금 백업 (with a lore snapshot), then a rename.
    const { path } = await h['leagues.backup'](slug)
    const next = input()
    next.teams[0]!.shortName = '새가람고'
    await h['leagues.saveSettings'](slug, next)
    expect(school('새가람고')).toEqual(['가가가.md', '새가람고 단장.md', '새가람고.md'])

    // The database from before the rename: the folder goes back with it.
    const restored = await h['backups.restore'](slug, basename(path))
    expect(restored.schools).toEqual([{ from: '새가람고', to: '가람고' }])
    expect(school('가람고')).toEqual(['가가가.md', '가람고 단장.md', '가람고.md'])
    expect(school('새가람고')).toBeNull()
    // So the rename can be made again.
    await h['leagues.saveSettings'](slug, next)
    expect(school('새가람고')).toEqual(['가가가.md', '새가람고 단장.md', '새가람고.md'])

    // The lore from before the rename: the folder takes the name the school has now.
    const snapshot = (await h['backups.list'](slug)).lore.find((s) => s.reason === 'manual')!
    const lore2 = await h['backups.restoreLore'](slug, snapshot.id)
    expect(lore2).toMatchObject({ schools: [{ from: '가람고', to: '새가람고' }], kept: null })
    expect(school('새가람고')).toEqual(['가가가.md', '새가람고 단장.md', '새가람고.md'])
    expect(school('가람고')).toBeNull()
    const links = linkLore(loadLoreFolder(join(folder(), 'lore')).entries, loreRefs(ctx.leagues.dbFor(slug)))
    expect(links.team.get('t1')?.sections.public).toBe('산 아래 학교.')
  })
})
