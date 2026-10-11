import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPrompt } from './prompts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('style guides', () => {
  const defaults = resolve(__dirname, '../../defaults')

  it('ships a community and a wiki guide with the hard lines in them', () => {
    const community = loadPrompt('community', null, defaults)!
    expect(community).toContain('매운맛')
    expect(community).toContain('패드립')
    expect(community).toContain('고등학생')
    expect(loadPrompt('wiki', null, defaults)).toContain('나무위키')
  })

  it("prefers the league's own guide, and falls back when there is none", () => {
    const league = mkdtempSync(join(tmpdir(), '2kw-prompts-'))
    dirs.push(league)
    mkdirSync(join(league, 'prompts'))
    writeFileSync(join(league, 'prompts', 'community.md'), '﻿우리 리그만의 말투')
    expect(loadPrompt('community', league, defaults)).toBe('우리 리그만의 말투')
    expect(loadPrompt('wiki', league, defaults)).toContain('나무위키')
    expect(loadPrompt('wiki', league, join(league, 'nowhere'))).toBeNull()
  })
})
