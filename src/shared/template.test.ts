import { describe, expect, it } from 'vitest'
import { autoMainBoard, followLeagueName } from './config/defaults'
import { migrateConfig, MigrationError } from './config/migrations'
import { CONFIG_VERSION } from './config/schema'
import { parseTemplate, serializeTemplate, TEMPLATE_FORMAT, TEMPLATE_FORMAT_VERSION, type TemplateFile } from './template'
import { sampleSetup } from './testing/fixtures'

function sampleTemplate(): TemplateFile {
  const { config, teams, players } = sampleSetup()
  return {
    format: TEMPLATE_FORMAT,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    meta: { name: '테스트', description: '', exportedAt: '2026-01-01T00:00:00.000Z', appVersion: '0.0.0' },
    config,
    teams,
    players,
  }
}

describe('templates', () => {
  it('round-trips through JSON', () => {
    const t = sampleTemplate()
    const result = parseTemplate(serializeTemplate(t))
    expect(result).toEqual({ ok: true, template: t })
  })

  it('rejects text that is not JSON or not a template', () => {
    expect(parseTemplate('{nope')).toEqual({ ok: false, error: { code: 'not-json' } })
    expect(parseTemplate('{"format":"other"}')).toEqual({ ok: false, error: { code: 'not-a-template' } })
  })

  it('rejects templates from a newer app', () => {
    const t = sampleTemplate() as unknown as Record<string, unknown>
    t.formatVersion = TEMPLATE_FORMAT_VERSION + 1
    expect(parseTemplate(JSON.stringify(t))).toMatchObject({ ok: false, error: { code: 'too-new' } })
    const u = sampleTemplate() as unknown as { config: { version: number } }
    u.config.version = 999
    expect(parseTemplate(JSON.stringify(u))).toMatchObject({ ok: false, error: { code: 'too-new', version: 999 } })
  })

  it('reports where an invalid template is wrong', () => {
    const t = sampleTemplate()
    t.teams![0]!.colors = ['red']
    const result = parseTemplate(JSON.stringify(t))
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.code === 'invalid') {
      expect(result.error.issues[0]?.path).toBe('teams.0.colors.0')
    } else {
      throw new Error('expected an invalid-template error')
    }
  })
})

describe('real migrations', () => {
  it('lifts a v1 config (no stat columns) to the current version', () => {
    const { config } = sampleSetup()
    const { stats: _, community: __, ...v1 } = { ...config, version: 1 }
    const t = { ...sampleTemplate(), config: v1 }
    const result = parseTemplate(JSON.stringify(t))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.template.config.version).toBe(CONFIG_VERSION)
      expect(result.template.config.stats.columns.map((c) => c.name)).toContain('PTS')
    }
  })

  it('lifts a v2 config: boards named after the league, 포텐 included', () => {
    const { config } = sampleSetup()
    const { community: _, ...v2 } = { ...config, version: 2, league: { name: '테스트 리그', shortName: '테리' } }
    const result = parseTemplate(JSON.stringify({ ...sampleTemplate(), config: v2 }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const boards = result.template.config.community.boards
      expect(boards.find((b) => b.role === 'main')?.name).toBe('테리')
      expect(boards.some((b) => b.role === 'poten')).toBe(true)
    }
  })
})

describe('main board name', () => {
  it('follows the league name until renamed', () => {
    const { config } = sampleSetup()
    const before = { ...config.league }
    config.community.boards[0]!.name = autoMainBoard(before)
    config.league.shortName = '새이름'
    followLeagueName(config, before)
    expect(config.community.boards[0]!.name).toBe('새이름')
    config.community.boards[0]!.name = '내 게시판'
    const again = { ...config.league }
    config.league.shortName = '또'
    followLeagueName(config, again)
    expect(config.community.boards[0]!.name).toBe('내 게시판')
  })
})

describe('migrateConfig', () => {
  const steps = [
    { from: 1, up: (c: Record<string, unknown>) => ({ ...c, renamed: c.old, old: undefined }) },
    { from: 2, up: (c: Record<string, unknown>) => ({ ...c, added: true }) },
  ]

  it('runs every step up to the target', () => {
    expect(migrateConfig({ version: 1, old: 'x' }, steps, 3)).toEqual({
      version: 3,
      renamed: 'x',
      old: undefined,
      added: true,
    })
  })

  it('leaves the input untouched', () => {
    const input = { version: 1, old: 'x' }
    migrateConfig(input, steps, 3)
    expect(input).toEqual({ version: 1, old: 'x' })
  })

  it('fails clearly', () => {
    expect(() => migrateConfig({ version: 5 }, steps, 3)).toThrow(MigrationError)
    expect(() => migrateConfig({}, steps, 3)).toThrow(/no-version/)
    expect(() => migrateConfig({ version: 1 }, [], 2)).toThrow(/missing-step/)
  })
})
