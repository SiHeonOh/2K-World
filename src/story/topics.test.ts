import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { TOPIC_KINDS } from '@shared/config/schema'
import { openDb, type Db } from '@data/db'
import { listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { listGames, recordScore, startSeason } from '@data/season'
import { chatterInput, ensureCast, readLeague } from './context'
import { planTopics } from './topics'

const SECRET = '사실은 전학을 원한다'
let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-topics-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  const [t1, t2] = listTeams(db)
  const p = listPlayers(db).find((x) => x.teamId === t1!.id)!
  const folder = join(dir, 'lore', 'teams', t1!.shortName)
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(dir, 'lore', 'world'), { recursive: true })
  writeFileSync(join(folder, `${t1!.shortName}.md`), `---\nid: ${t1!.shortName}\nrivals:\n  - ${t2!.shortName}\n---\n## 공개\n전통의 명문.\n`)
  writeFileSync(join(folder, `${p.name}.md`), `---\nid: ${p.name}\n---\n## 공개\n별명은 저격수.\n\n## 소문\n감독과 불화설.\n\n## 비밀\n${SECRET}\n`)
  writeFileSync(join(dir, 'lore', 'world', '왕 논쟁.md'), '---\nid: 왕 논쟁\ntype: topic\n---\n## 공개\n누가 진짜 왕인가.\n')
  startSeason(db)
  const g = listGames(db, 1)[0]!
  recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 75, lines: null })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('chatter topics', () => {
  it('plans a varied mix, mostly not about games, each with facts to stand on', () => {
    const league = readLeague(db, dir)
    const kinds = new Set<string>()
    for (let seed = 1; seed <= 20; seed++) {
      const plan = planTopics(league, 8, seed)
      expect(plan.length).toBeGreaterThanOrEqual(6)
      expect(plan.filter((s) => s.kind === 'game_talk').length).toBeLessThanOrEqual(1)
      for (const s of plan) kinds.add(s.kind)
      // At most two of a kind in one batch.
      for (const k of TOPIC_KINDS) expect(plan.filter((s) => s.kind === k).length).toBeLessThanOrEqual(2)
    }
    // Over a few refreshes, nearly everything comes up: lore, rumors, world topics, rivalries, roasts, memes, off-topic…
    for (const k of ['lore_story', 'rumor', 'world_topic', 'rivalry', 'league_roast', 'rankings', 'meme', 'off_topic', 'newbie', 'school_pride', 'poll']) expect(kinds).toContain(k)
    const rivalry = planTopics(league, 15, 3).find((s) => s.kind === 'rivalry')
    if (rivalry) expect(rivalry.facts.some((f) => f.includes('승'))).toBe(true)
  })

  it('follows the league’s mix: a weight of 0 never comes up', () => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, community: { ...config.community, topicMix: { game_talk: 0, meme: 5, off_topic: 0 } } })
    const league = readLeague(db, dir)
    for (let seed = 1; seed <= 15; seed++) {
      const plan = planTopics(league, 8, seed)
      expect(plan.some((s) => s.kind === 'game_talk' || s.kind === 'off_topic')).toBe(false)
    }
  })

  it('hands the writers the plan and the lore, but never a secret', () => {
    const league = readLeague(db, dir)
    ensureCast(league)
    const input = chatterInput(league)
    expect(input.context).toContain('# 이번에 쓸 글')
    expect(input.context).not.toContain(SECRET)
    expect(JSON.stringify(input)).not.toContain(SECRET)
  })
})
