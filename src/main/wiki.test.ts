import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { giveAward } from '@data/moves'
import { updatePlayers } from '@data/roster'
import { listGames, recordScore, startSeason } from '@data/season'
import { pageByRef, pageByTitle, revisionBody, saveRevision, sectionsYouOwn } from '@data/wiki'
import { syncSchoolCategories } from '@story/wiki'
import { WikiService } from './wiki'

let dir: string
let db: Db
const wiki = new WikiService()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-wiki-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  // Two players share a name: their pages get the school in brackets.
  setup.players[0]!.name = '같은이름'
  setup.players[10]!.name = '같은이름'
  seedLeague(db, setup)
  const team = listTeams(db)[0]!
  mkdirSync(join(dir, 'lore', 'world'), { recursive: true })
  writeFileSync(join(dir, 'lore', 'world', '왕 논쟁.md'), `---\nid: 왕 논쟁\ninvolves: [${team.shortName}]\n---\n## 공개\n누가 진짜 왕인가.\n## 비밀\n아무도 모르는 일\n`)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('WikiService', () => {
  it('seeds a page for everyone and everything, once', () => {
    const home = wiki.home(db, dir)
    const players = listPlayers(db)
    const teams = listTeams(db)
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM wiki_pages').get() as { n: number }).n
    // league, rules, awards, draft, season, teams, players, one world topic
    expect(count()).toBe(5 + teams.length + players.length + 1)
    wiki.ensure(db, dir, true)
    expect(count()).toBe(5 + teams.length + players.length + 1)
    const short = (id: string) => teams.find((t) => t.id === id)!.shortName
    const twins = players.filter((p) => p.name === '같은이름')
    for (const p of twins) expect(pageByTitle(db, `같은이름(${short(p.teamId)})`)).not.toBeNull()
    const league = wiki.page(db, dir, home)
    expect(league.exists).toBe(true)
    expect(league.source).toContain(`[[${teams[0]!.shortName}]]`)
    expect(league.existing).toContain(teams[0]!.shortName)
    // Lore topics carry 공개, never 비밀.
    const topic = wiki.page(db, dir, '왕 논쟁')
    expect(topic.source).toContain('누가 진짜 왕인가')
    expect(topic.source).not.toContain('아무도 모르는 일')
  })

  it('fills infoboxes and macros from the league, live', () => {
    wiki.ensure(db, dir, true)
    startSeason(db)
    const game = listGames(db, 1)[0]!
    const team = listTeams(db).find((t) => t.id === game.home)!
    const star = listPlayers(db).find((p) => p.teamId === team.id)!
    recordScore(db, { gameId: game.id, homeScore: 90, awayScore: 80, lines: [{ playerId: star.id, teamId: team.id, stats: { pts: 33, reb: 5, ast: 4 } }] })
    const teamPage = wiki.page(db, dir, team.shortName)
    expect(teamPage.data.infobox?.rows.find((r) => r.label === '이번 시즌')?.value).toContain('1승 0패')
    expect(teamPage.data.roster?.rows.length).toBeGreaterThan(0)
    expect(teamPage.data.recent?.rows[0]?.cells[2]).toBe('승 90:80')
    const title = db.prepare("SELECT title FROM wiki_pages WHERE kind = 'player' AND ref_id = ?").get(star.id) as { title: string }
    const playerPage = wiki.page(db, dir, title.title)
    // 소속: the school's full name, linked to its page.
    expect(playerPage.data.infobox?.rows[0]).toMatchObject({ label: '소속', value: team.name, link: team.shortName })
    expect(playerPage.data.record?.rows[0]?.cells.slice(2, 4)).toEqual(['1', '33.0'])
    expect(playerPage.data.history.map((h) => h.text)).toEqual([expect.stringContaining('33점')])
  })

  it('shows a card-swap league’s draft cards in a school’s infobox: held now, and what it’s on track to have', () => {
    const { config } = loadConfig(db)
    updateConfig(db, {
      ...config,
      draft: {
        ...defaultCardSwap(8),
        allocation: [
          { fromRank: 1, toRank: 1, cards: 5 },
          { fromRank: 2, toRank: 8, cards: 3 },
        ],
      },
    })
    wiki.ensure(db, dir, true)
    const row = (title: string) => wiki.page(db, dir, title).data.infobox?.rows.find((r) => r.label === '드래프트 카드')
    startSeason(db)
    expect(row('가람고')).toMatchObject({ value: '3장 보유', link: '테스트 리그/드래프트' })
    const game = listGames(db, 1).find((g) => g.home === 't1' || g.away === 't1')!
    recordScore(db, { gameId: game.id, homeScore: game.home === 't1' ? 90 : 80, awayScore: game.home === 't1' ? 80 : 90, lines: null })
    // 가람고 won its game: 1st now, two more cards at the end if it stays there.
    expect(row('가람고')?.value).toBe('3장 보유 · 드래프트 예상 5장')
    // No card-swap draft, no row.
    updateConfig(db, { ...loadConfig(db).config, draft: { kind: 'none' } })
    expect(row('가람고')).toBeUndefined()
  })

  it('names weekly and monthly awards by period and group: the 시상 page, his infobox and his history', () => {
    // 이주의 선수 per conference (the sample's are 동 and 서), 이달의 선수 league-wide.
    const { config } = loadConfig(db)
    config.awards.periodic[0]!.scope = 'conference'
    updateConfig(db, config)
    wiki.ensure(db, dir, true)
    startSeason(db)
    // p2 plays for t1 (동).
    giveAward(db, { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p2' })
    giveAward(db, { awardId: 'potw', period: 'w10', teamRank: 1, playerId: 'p2' })
    giveAward(db, { awardId: 'potm', period: 'm2', teamRank: 1, playerId: 'p2' })
    const awards = wiki.page(db, dir, `${config.league.name}/시상`)
    expect(awards.source).toContain(' * 이주의 선수: 매주 동·서에서 1명씩')
    expect(awards.source).toContain(' * 이달의 선수: 매달 1명')
    const name = listPlayers(db).find((p) => p.id === 'p2')!.name
    expect(awards.data.record?.rows.map((r) => r.cells)).toEqual([
      ['시즌 1', '이달의 선수', '11월', name],
      ['시즌 1', '동 이주의 선수', '3주차', name],
      ['시즌 1', '동 이주의 선수', '10주차', name],
    ])
    const title = (db.prepare("SELECT title FROM wiki_pages WHERE kind = 'player' AND ref_id = ?").get('p2') as { title: string }).title
    const page = wiki.page(db, dir, title)
    expect(page.data.infobox?.rows.find((r) => r.label === '수상')?.value).toBe('이달의 선수, 동 이주의 선수 2회')
    expect(page.data.history.map((h) => h.text)).toEqual(['수상: 3주차 동 이주의 선수', '수상: 10주차 동 이주의 선수', '수상: 11월 이달의 선수'])
  })

  it('a lineup change shows live in the infobox; going to the bench goes in his history, PG to SG doesn’t', () => {
    wiki.ensure(db, dir, true)
    // p5 is the first school's C, p6 its bench; p1 its PG (같은이름), p2 its SG.
    const titleOf = (id: string) => (db.prepare("SELECT title FROM wiki_pages WHERE kind = 'player' AND ref_id = ?").get(id) as { title: string }).title
    updatePlayers(db, [
      { playerId: 'p5', slotId: 'bench' },
      { playerId: 'p6', slotId: 'c' },
      { playerId: 'p1', slotId: 'sg' },
      { playerId: 'p2', slotId: 'pg' },
    ])
    const benched = wiki.page(db, dir, titleOf('p5'))
    expect(benched.data.infobox?.rows.find((r) => r.label === '포지션')?.value).toBe("'''벤치 멤버'''")
    expect(benched.data.history.map((h) => h.text)).toEqual(['벤치로 이동 (센터 → 벤치 멤버)'])
    expect(wiki.page(db, dir, titleOf('p6')).data.history.map((h) => h.text)).toEqual(['주전 발탁 (벤치 멤버 → 센터)'])
    expect(wiki.page(db, dir, titleOf('p2')).data.history).toEqual([])
  })

  it('saves your edits as revisions, refuses a stale edit, and finds pages', () => {
    const home = wiki.home(db, dir)
    const page = wiki.page(db, dir, home)
    const { rev } = wiki.save(db, { title: home, source: `${page.source}\n== 여담 ==\n내가 쓴 줄. [[새 문서]]`, summary: '여담 추가', baseRev: page.rev })
    expect(rev).toBe(2)
    expect(() => wiki.save(db, { title: home, source: 'x', summary: '', baseRev: 1 })).toThrow(/wiki-conflict/)
    expect(wiki.history(db, home).map((r) => [r.rev, r.author.kind, r.summary])).toEqual([
      [2, 'user', '여담 추가'],
      [1, 'system', '문서 생성'],
    ])
    expect(wiki.recent(db).map((r) => r.pageTitle)).toEqual([home])
    expect(wiki.page(db, dir, '새 문서')).toMatchObject({ exists: false, backlinks: 1 })
    expect(wiki.backlinks(db, '새 문서')).toEqual([home])
    expect(wiki.search(db, '내가 쓴 줄')[0]).toMatchObject({ title: home })
    // A new page, then the old revision still readable.
    wiki.save(db, { title: '새 문서', source: '== 개요 ==\n처음', summary: '', baseRev: null })
    expect(wiki.page(db, dir, '새 문서').exists).toBe(true)
    expect(wiki.page(db, dir, home, 1).source).toBe(page.source)
  })

  it('keeps a traded twin on his own page, under its old title', () => {
    wiki.ensure(db, dir, true)
    const [p1, p11] = listPlayers(db).filter((p) => p.name === '같은이름')
    const short = (id: string) => listTeams(db).find((t) => t.id === id)!.shortName
    const page1 = `같은이름(${short(p1!.teamId)})`
    // p1 joins p11's school: both would now compute the same title.
    db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(p11!.teamId, p1!.id)
    const team = wiki.page(db, dir, short(p11!.teamId))
    const links = team.data.roster!.rows.filter((r) => r.cells[0] === '같은이름').map((r) => r.link)
    expect(links.sort()).toEqual([page1, `같은이름(${short(p11!.teamId)})`].sort())
    expect(wiki.page(db, dir, page1).data.infobox?.rows[0]).toMatchObject({ value: listTeams(db).find((t) => t.id === p11!.teamId)!.name, link: short(p11!.teamId) })
  })

  it("refiles a moved player's page under the new school, leaving the rest as written", () => {
    wiki.ensure(db, dir, true)
    const teams = listTeams(db)
    const p = listPlayers(db).find((x) => x.name !== '같은이름')!
    const from = teams.find((t) => t.id === p.teamId)!.shortName
    const to = teams.find((t) => t.id !== p.teamId)!
    const page = pageByRef(db, 'player', p.id)!
    const before = revisionBody(db, page.id, page.currentRev!)!.body
    expect(before).toContain(`[[분류:${from} 선수]]`)
    // You added a line naming the old school inline, and a second copy of its category.
    wiki.save(db, { title: page.title, source: `${before}\n${from} 시절 이야기 [[분류:${from} 선수]]\n[[분류:${from} 선수]]`, summary: '', baseRev: page.currentRev })
    expect(syncSchoolCategories(db, loadConfig(db).config, Date.now())).toBe(0)
    db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(to.id, p.id)
    expect(syncSchoolCategories(db, loadConfig(db).config, Date.now(), ['someone-else'])).toBe(0)
    // Opening the page catches it up: one line now names the new school, the copy is gone, the inline one stays.
    const view = wiki.page(db, dir, page.title)
    const lines = view.source.split('\n')
    expect(lines.filter((l) => l === `[[분류:${to.shortName} 선수]]`)).toHaveLength(1)
    expect(lines.filter((l) => l === `[[분류:${from} 선수]]`)).toHaveLength(0)
    expect(view.source).toContain(`${from} 시절 이야기 [[분류:${from} 선수]]`)
    expect(view.source).toContain('[[분류:선수]]')
    expect(wiki.history(db, page.title)[0]).toMatchObject({ summary: '소속 분류 갱신', author: { kind: 'system' } })
    // Nothing more to do the second time.
    expect(syncSchoolCategories(db, loadConfig(db).config, Date.now())).toBe(0)
  })

  it("files players under a renamed school's new name, knowing either name, keeping a sort key", () => {
    wiki.ensure(db, dir, true)
    const [a, b] = listTeams(db)
    const p = listPlayers(db).find((x) => x.teamId === a!.id && x.name !== '같은이름')!
    const q = listPlayers(db).find((x) => x.teamId === b!.id && x.name !== '같은이름')!
    const bodyOf = (id: string) => {
      const page = pageByRef(db, 'player', id)!
      return revisionBody(db, page.id, page.currentRev!)!.body
    }
    // The school is renamed: its page keeps the old title, its players' pages still say the old name.
    db.prepare('UPDATE teams SET short_name = ? WHERE id = ?').run('새이름고', b!.id)
    const page = pageByRef(db, 'player', p.id)!
    saveRevision(db, { title: page.title, body: bodyOf(p.id).replace(`[[분류:${a!.shortName} 선수]]`, `[[분류:${a!.shortName} 선수|가]]`), authorId: 'me', summary: '' }, Date.now())
    db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(b!.id, p.id)
    syncSchoolCategories(db, loadConfig(db).config, Date.now(), [p.id])
    // Filed under the new name, the sort key kept.
    expect(bodyOf(p.id)).toContain('[[분류:새이름고 선수|가]]')
    expect(bodyOf(p.id)).not.toContain(`[[분류:${a!.shortName} 선수`)
    // The school's own player catches up too: the old name is the same school, just stale.
    expect(bodyOf(q.id)).toContain(`[[분류:${b!.shortName} 선수]]`)
    syncSchoolCategories(db, loadConfig(db).config, Date.now(), [q.id])
    expect(bodyOf(q.id)).toContain('[[분류:새이름고 선수]]')
    expect(bodyOf(q.id)).not.toContain(`[[분류:${b!.shortName} 선수]]`)
    expect(syncSchoolCategories(db, loadConfig(db).config, Date.now())).toBe(listPlayers(db).filter((x) => x.teamId === b!.id && x.id !== q.id && x.id !== p.id).length)
  })

  it('handles titles with brackets or #: the wiki stays up and links resolve', () => {
    db.prepare("UPDATE league_config SET json = json_set(json, '$.league.name', '[2K] 테스트 #1')").run()
    mkdirSync(join(dir, 'lore', 'world'), { recursive: true })
    writeFileSync(join(dir, 'lore', 'world', '샵.md'), '---\nid: "가람고#"\n---\n## 공개\n샵 문서.\n')
    const home = wiki.home(db, dir)
    expect(home).toBe('2K 테스트 1')
    expect(wiki.page(db, dir, home).exists).toBe(true)
    expect(wiki.page(db, dir, '[2K] 테스트 #1').title).toBe(home)
    expect(wiki.page(db, dir, '가람고').exists).toBe(true)
    const saved = wiki.save(db, { title: 'C# 문법', source: '== 개요 ==\n샵', summary: '', baseRev: null })
    expect(saved.title).toBe('C 문법')
    expect(wiki.page(db, dir, 'C# 문법')).toMatchObject({ exists: true, title: 'C 문법' })
  })

  it('compares two revisions, older first, clamped to the page', () => {
    saveRevision(db, { title: '연습', body: '== 개요 ==\n3연승 중이다.\n끝', authorId: 'system', summary: '문서 생성' }, 1)
    saveRevision(db, { title: '연습', body: '== 개요 ==\n4연승 중이다.\n끝\n새 줄', authorId: 'me', summary: '갱신' }, 2)
    const d = wiki.diff(db, '연습', 2, 1)
    expect([d.from.rev, d.to.rev, d.latestRev, d.to.summary]).toEqual([1, 2, 2, '갱신'])
    expect(d.diff).toMatchObject({ added: 2, removed: 1 })
    expect(wiki.diff(db, '연습', 0, 99)).toMatchObject({ from: { rev: 1 }, to: { rev: 2 } })
    expect(wiki.diff(db, '연습', 2, 2).diff).toMatchObject({ added: 0, removed: 0 })
    expect(() => wiki.diff(db, '없는 문서', 1, 2)).toThrow(/wiki-no-page/)
  })

  it('knows which sections you wrote last', () => {
    const { pageId } = saveRevision(db, { title: '연습', body: '== 가 ==\n시스템\n== 나 ==\n시스템', authorId: 'system', summary: '' }, 1)
    saveRevision(db, { title: '연습', body: '== 가 ==\n내가 고침\n== 나 ==\n시스템', authorId: 'me', summary: '' }, 2)
    saveRevision(db, { title: '연습', body: '== 가 ==\n내가 고침\n== 나 ==\n편집자', authorId: 'f001', summary: '' }, 3)
    expect([...sectionsYouOwn(db, pageId)]).toEqual(['가'])
    // A section of yours that you then deleted isn't yours any more, so it can't block every later edit.
    saveRevision(db, { title: '연습', body: '== 나 ==\n편집자', authorId: 'me', summary: '' }, 4)
    expect([...sectionsYouOwn(db, pageId)]).toEqual([])
  })
})
