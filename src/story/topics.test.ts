import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { TOPIC_KINDS } from '@shared/config/schema'
import { listPersonas } from '@data/community'
import { openDb, type Db } from '@data/db'
import { listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { listGames, recordScore, startSeason } from '@data/season'
import { chatterInput, ensureCast, readLeague } from './context'
import { storyDemo } from './jobs'
import { readFacts, unknownNumbers } from './numbers'
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

  it('gives posts lengths by the mix: mostly one-liners and short ones, a long one at most, polls and questions never long', () => {
    const league = readLeague(db, dir)
    const tally = { line: 0, short: 0, medium: 0, long: 0 }
    for (let seed = 1; seed <= 20; seed++) {
      for (const [count, quota] of [
        [10, { line: 4, medium: 2, long: 1 }],
        [8, { line: 3, medium: 2, long: 1 }],
      ] as const) {
        const plan = planTopics(league, count, seed)
        const n = (l: string) => plan.filter((s) => s.length === l).length
        expect(n('long')).toBeLessThanOrEqual(quota.long)
        expect(n('medium')).toBe(quota.medium)
        expect(n('line')).toBeLessThanOrEqual(quota.line)
        for (const s of plan) {
          if (s.kind === 'poll' || s.kind === 'newbie') expect(['line', 'short']).toContain(s.length)
          if (s.length === 'long') expect(s.form).toMatch(/^(분석글|썰|뇌피셜|비교글)$/)
          tally[s.length]++
        }
      }
    }
    // Over many refreshes: one-liners lead, long posts are rare.
    expect(tally.line).toBeGreaterThan(tally.medium)
    expect(tally.long).toBeLessThan(tally.medium)
    expect(tally.long).toBeGreaterThan(0)
    // With the day's long posts used up, none.
    for (let seed = 1; seed <= 10; seed++) expect(planTopics(league, 10, seed, 0).some((s) => s.length === 'long')).toBe(false)
  })

  it('never plans 드래프트 보호 위기 in a league without the card-swap draft', () => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, community: { ...config.community, topicMix: { draft_watch: 5 } } })
    const league = readLeague(db, dir)
    for (let seed = 1; seed <= 15; seed++) expect(planTopics(league, 8, seed).some((s) => s.kind === 'draft_watch')).toBe(false)
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

describe('analysis topics', () => {
  /** Four rounds, every player on the box score (made-up lines adding up to the score). */
  function playRounds() {
    const games = listGames(db, 1).filter((g) => g.status === 'scheduled' && g.round <= 4)
    games.forEach((g, n) => {
      const lines = listPlayers(db)
        .filter((p) => p.teamId === g.home || p.teamId === g.away)
        .map((p, i) => {
          const fgm = 3 + ((n + i) % 6)
          const tpm = (n + i) % 3
          return { playerId: p.id, teamId: p.teamId, stats: { pts: 2 * fgm + tpm, reb: 2 + (i % 7), ast: 1 + ((n * i) % 5), fgm, fga: fgm + 6, '3pm': tpm, '3pa': tpm + 3, ftm: 0, fta: 0 } }
        })
      const sum = (team: string) => lines.filter((l) => l.teamId === team).reduce((s, l) => s + l.stats.pts, 0)
      if (sum(g.home) === sum(g.away)) {
        const top = lines.find((l) => l.teamId === g.home)!.stats
        top.pts += 2
        top.fgm += 1
        top.fga += 1
      }
      recordScore(db, { gameId: g.id, homeScore: sum(g.home), awayScore: sum(g.away), lines })
    })
  }
  const mixOf = (topicMix: Record<string, number>) => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, community: { ...config.community, topicMix } })
  }

  it('is planned at weight > 0, once a batch and long, with the stats pack of who it’s about; never at 0', () => {
    playRounds()
    mixOf({ analysis: 5 })
    const league = readLeague(db, dir)
    const found = []
    for (let seed = 1; seed <= 12; seed++) {
      const plan = planTopics(league, 8, seed)
      const studies = plan.filter((s) => s.kind === 'analysis')
      expect(studies.length).toBeLessThanOrEqual(1)
      found.push(...studies)
    }
    expect(found.length).toBeGreaterThan(6)
    for (const s of found) {
      expect(s.length).toBe('long')
      expect(s.form).toBe('분석글')
      expect(s.tag).toBe('분석')
      expect(s.brief).toMatch(/^장문 분석 글\(뼈대 [BCD]\): /)
      expect(s.facts[0]).toMatch(/^주제: /)
      // Its numbers: a school's profile or a player's season, for exactly those it names.
      expect(s.pack!.length).toBeGreaterThan(3)
      expect(s.pack!.some((l) => /^\[\S+\] /.test(l))).toBe(true)
      const named = [...s.teams.map((t) => league.teams.get(t)!.shortName), ...s.players.map((p) => league.players.get(p)!.name)]
      for (const name of named) expect(s.pack!.join('\n')).toContain(name)
    }
    // Not at 0, and not once the day's long posts are used up.
    mixOf({ analysis: 0 })
    for (let seed = 1; seed <= 12; seed++) expect(planTopics(readLeague(db, dir), 8, seed).some((s) => s.kind === 'analysis')).toBe(false)
    mixOf({ analysis: 5 })
    for (let seed = 1; seed <= 12; seed++) expect(planTopics(readLeague(db, dir), 8, seed, 0).some((s) => s.kind === 'analysis')).toBe(false)
  })

  it('goes to a reporter or an analyst fan in the chatter plan, its pack a line each, and counts toward the day’s long posts', () => {
    playRounds()
    mixOf({ analysis: 5 })
    const league = readLeague(db, dir)
    ensureCast(league)
    const spy = vi.spyOn(Date, 'now')
    let input: ReturnType<typeof chatterInput> | null = null
    for (let t = 0; t < 20 && !input; t++) {
      spy.mockReturnValue(Date.parse('2026-10-11T12:00:00Z') + t)
      const c = chatterInput(readLeague(db, dir))
      if (c.context.includes('[분석 글 · ')) input = c
    }
    spy.mockRestore()
    expect(input).not.toBeNull()
    const head = input!.context.split('\n').find((l) => l.includes('[분석 글 · '))!
    const writer = /글쓴이 ([rf]\d+)/.exec(head)![1]!
    const persona = listPersonas(db).find((p) => p.id === writer)!
    expect(persona.kind === 'reporter' || ['analyst', 'stats'].includes(persona.archetype)).toBe(true)
    // A reporter's carries [분석]; a fan picks his own 말머리. The writer is in the cast block either way.
    expect(head.includes('말머리 분석')).toBe(persona.kind === 'reporter')
    expect(input!.context).toContain(`\n${writer} · `)
    expect(input!.context).toMatch(/\n {3}\[\S+\] /)
    expect(input!.long).toBeGreaterThanOrEqual(1)
    // The demo writer makes it a long post from its pack, every number from the facts.
    const post = storyDemo('chatter_batch', input!)!.posts.find((p) => p.author === writer && p.body.startsWith('■ '))!
    expect(post.body.split('\n').length).toBeGreaterThan(8)
    expect(unknownNumbers(`${post.title}\n${post.body}`, readFacts(input!.context, input!.instructions))).toEqual([])
    // The day's two long posts planned: no more analysis or 장문 today.
    const iso = new Date().toISOString()
    db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('chatter_batch', 'done', 10, ?, ?)").run(JSON.stringify({ long: 2 }), iso)
    for (let t = 0; t < 8; t++) {
      const spy2 = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T12:00:00Z') + 100 + t)
      const c = chatterInput(readLeague(db, dir))
      spy2.mockRestore()
      expect(c.context).not.toContain('[분석 글 · ')
      expect(c.context).not.toContain('길이 장문')
      expect(c.long).toBe(0)
    }
  })
})
