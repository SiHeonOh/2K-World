import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { parseWiki, shownPage } from '@shared/namumark'
import { macroFilled } from '@shared/wiki'
import { storyValue } from '@data/community'
import { openDb, transaction, type Db } from '@data/db'
import { listGames, recordScore, startSeason } from '@data/season'
import { listPlayers, seedLeague } from '@data/league'
import { updatePlayers } from '@data/roster'
import { pageByRef, revisionBody, saveRevision, sectionKeys, sectionsYouOwn, SYSTEM } from '@data/wiki'
import type { JobRow } from '@ai/queue'
import { forgetLore, readLeague } from '@story/context'
import { STORY_PRIORITY, storyDemo, storyKinds } from '@story/jobs'
import { upgradeWiki } from '@story/wiki'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { pageNeed, planPlayerPages, playerPagesInput, WIKI_PLAYER, WIKI_PLAYER_PRIORITY, wikiPlayerDemo, wikiPlayerKind, type WikiPlayerInput } from '@story/wikiPlayer'
import { AiService } from './ai'
import { StoryService } from './story'
import { WikiService } from './wiki'

const SECRET = '사실은 전학을 원한다'
const RUMOR = '감독과 불화설'

let dir: string
let db: Db
let ai: AiService
let story: StoryService
const wiki = new WikiService()

/** The made-up league, rated as 2K sheets write it: an OVR and graded categories, in English. */
function league() {
  const setup = sampleSetup()
  setup.config.ratings.columns = [
    { id: 'ovr', name: 'OVR', kind: 'number', min: 40, max: 99, weight: 1 },
    { id: 'ath', name: 'Athleticism', kind: 'grade', weight: 1 },
    { id: 'ind', name: 'Inside D', kind: 'grade', weight: 1 },
    { id: 'three', name: '3pt', kind: 'grade', weight: 1 },
  ]
  setup.players.forEach((p, i) => {
    p.ratings = { ovr: 70 + (i % 6), ath: ['A+', 'B', 'C'][i % 3]!, ind: ['D', 'B+', 'A'][i % 3]!, three: 'B' }
  })
  setup.players[0]!.nicknames = ['총알']
  setup.teams[0]!.colors = ['#1d4ed8', '#facc15']
  return setup
}

const loreFile = (team: string, name: string, text: string) => {
  mkdirSync(join(dir, 'lore', 'teams', team), { recursive: true })
  writeFileSync(join(dir, 'lore', 'teams', team, `${name}.md`), text)
  forgetLore(dir)
}

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-wikiplayer-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, league())
  // 가가가 (p1, 가람고): public lore with a play sentence, a rumour, a secret; ties of every kind of visibility.
  loreFile(
    '가람고',
    '가가가',
    [
      '---',
      'id: 가가가',
      'relationships:',
      '  - { with: 가나나, type: friend, strength: 4, visibility: public }',
      '  - { with: 가다다, type: rival, strength: 3, visibility: rumor }',
      '  - { with: 가라라, type: dislikes, strength: 5, visibility: secret }',
      '---',
      '## 공개',
      '빠른 발로 코트를 가른다. 3점슛이 주무기다.',
      '## 소문',
      `${RUMOR}.`,
      '## 비밀',
      SECRET,
      '',
    ].join('\n'),
  )
  // Other players' ties with him: a public one shows on his page, a secret one never does.
  loreFile('나람고', '나나다', '---\nid: 나나다\nrelationships:\n  - { with: 가가가, type: rival, strength: 5, visibility: public }\n---\n')
  loreFile('나람고', '나가나', '---\nid: 나가나\nrelationships:\n  - { with: 가가가, type: dislikes, strength: 4, visibility: secret }\n---\n')
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d) => [wikiPlayerKind(d, () => null, { requeue: (input) => void ai.queueFor('test', d, dir).enqueue(WIKI_PLAYER, input, WIKI_PLAYER_PRIORITY) })], wikiPlayerDemo)
  await ai.refresh()
  story = new StoryService(ai)
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  delete process.env.TWOK_FAKE_HOLD
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = () => ai.queueFor('test', db, dir).kick()
const titleOf = (id: string) => pageByRef(db, 'player', id)!.title
const bodyOf = (id: string) => {
  const page = pageByRef(db, 'player', id)!
  return revisionBody(db, page.id, page.currentRev!)!.body
}
const section = (id: string, title: string) => sectionKeys(bodyOf(id)).get(`${title}#1`)
const playerJobs = () =>
  (db.prepare('SELECT id, status, priority, input FROM jobs WHERE kind = ? ORDER BY id').all(WIKI_PLAYER) as { id: number; status: string; priority: number; input: string }[]).map((j) => ({
    ...j,
    input: JSON.parse(j.input) as WikiPlayerInput,
  }))

/** Round 1 played with box lines: 가가가 (p1) scores most. */
function playRound1() {
  for (const g of listGames(db, 1).filter((x) => x.round === 1)) {
    const lines = g.home === 't1' || g.away === 't1' ? [{ playerId: 'p1', teamId: 't1', stats: { pts: 31, reb: 7, ast: 5, fgm: 12, fga: 20, '3pm': 3, '3pa': 7 } }] : null
    recordScore(db, { gameId: g.id, homeScore: g.home === 't1' ? 90 : 80, awayScore: g.home === 't1' ? 80 : 90, lines })
  }
}

describe('a player page', () => {
  it('reads in Korean: the infobox, the season table, the app’s own 개요 and 플레이 스타일, and his ties', () => {
    wiki.ensure(db, dir, true)
    startSeason(db)
    playRound1()
    const view = wiki.page(db, dir, titleOf('p1'))
    const box = view.data.infobox!
    // His school above his name, in its colours; only rows with something to say.
    expect(box.band).toBe('가람고')
    expect(box.rows.map((r) => [r.label, r.value])).toEqual([
      ['소속', '가람고등학교'],
      // 가마마 (p5) is 가람고's best: p1 is a starter, not its ace.
      ['포지션', "'''포인트 가드(PG)'''"],
      ['신체', `185cm (6' 1")`],
      ['특기', '운동 능력'],
      // His public rival (another player's tie with him); the rumoured one isn't stated.
      ['라이벌', '[[나나다]]'],
      ['별명', '총알'],
    ])
    expect(box.rows[0]!.link).toBe('가람고')
    // His 2K ratings in Korean, the overall first, folded away under 능력치.
    expect(box.ratings).toEqual({
      title: '능력치',
      rows: [
        { label: '종합', value: '70', grade: false, source: 'OVR' },
        { label: '운동 능력', value: 'A+', grade: true, source: 'Athleticism' },
        { label: '골밑 수비', value: 'D', grade: true, source: 'Inside D' },
        { label: '3점 슛', value: 'B', grade: true, source: '3pt' },
      ],
    })
    const record = view.data.record!
    expect(record.columns).toEqual(['시즌', '소속', '경기', '득점', '리바운드', '어시스트', '스틸', '블록', '야투율', '3점 슛 성공률'])
    expect(record.rows[0]?.cells.slice(2)).toEqual(['1', '31.0', '7.0', '5.0', '0.0', '0.0', '60.0%', '42.9%'])
    // What led the league is in bold (a zero never is); one season has no 통산 row yet.
    expect(record.rows[0]?.bold).toEqual([3, 4, 5, 8, 9])
    expect(record.rows).toHaveLength(1)
    // 개요: a noun phrase for his school, his position, the first sentence of 공개 (never 소문 or 비밀), his nickname in bold.
    expect(view.data.auto['개요']).toBe("[[가람고|가람고등학교]] 농구부 소속의 농구 선수. 포지션은 포인트 가드. 빠른 발로 코트를 가른다. 별명은 '''총알'''.")
    const style = view.data.auto['플레이 스타일']!
    expect(style).toMatch(/^'''.+가람고의 포인트 가드\.'''/)
    expect(style).toContain('운동 능력')
    expect(style).toContain('골밑 수비')
    expect(style).not.toMatch(/[A-Za-z]/)
    expect(view.existing).toContain('가람고')
    // Ties: his public and rumoured ones, then another player's public one; never a secret one, from either side.
    expect(view.data.relations.map((r) => [r.name, r.team, r.text, r.rumor])).toEqual([
      ['가나나', '가람고', '절친', false],
      ['가다다', '가람고', '라이벌이라는 소문이 있다', true],
      ['나나다', '나람고', '숙적', false],
    ])
    expect(JSON.stringify(view.data)).not.toContain(SECRET)
    expect(JSON.stringify(view.data)).not.toContain(RUMOR)
    // The page's own text has no English rating names, no slot code, no feet and inches.
    expect(view.source).not.toMatch(/Athleticism|Inside D|\bPG\b|'/)
  })

  it('leaves empty sections out of the article and its 목차, but not out of the source', () => {
    wiki.ensure(db, dir, true)
    const shown = (id: string) => {
      const view = wiki.page(db, dir, titleOf(id))
      const page = shownPage(parseWiki(view.source), (m) => macroFilled(view.data, m), (t) => Boolean(view.data.auto[t]))
      return { source: view.source, toc: page.headings.map((h) => `${h.num}. ${h.title}`) }
    }
    // Before any game: no season, no history, no nicknames' section; his 여담 has the 카더라 line his 소문 seeded.
    const ace = shown('p1')
    expect(ace.toc).toEqual(['1. 개요', '2. 플레이 스타일', '3. 인간관계', '4. 여담'])
    for (const title of ['== 시즌별 활약 ==', '== 역사 ==', '== 별명 ==']) expect(ace.source).toContain(title)
    // Nobody's ties and no lore: no 인간관계 or 여담 either.
    const quiet = shown('p6')
    expect(quiet.toc).toEqual(['1. 개요', '2. 플레이 스타일'])
    expect(quiet.source).toContain('== 여담 ==')
    // A game played: his season shows, and the 30-point night his history, before how he plays (as on Namuwiki).
    startSeason(db)
    playRound1()
    expect(shown('p1').toc).toEqual(['1. 개요', '2. 시즌별 활약', '3. 역사', '4. 플레이 스타일', '5. 인간관계', '6. 여담'])
  })
})

describe('a school page', () => {
  const shown = (title: string) => {
    const view = wiki.page(db, dir, title)
    const page = shownPage(parseWiki(view.source), (m) => macroFilled(view.data, m), (t) => Boolean(view.data.auto[t]))
    return { view, toc: page.headings.map((h) => `${h.num}. ${h.title}`) }
  }

  it('lays out as Namuwiki’s: a 농구부 infobox, then 개요 and 선수단, more sections as they fill', () => {
    wiki.ensure(db, dir, true)
    const before = shown('가람고')
    // 상세, 향후 전망 and 여담 wait for someone to write them; the season's sections for its games.
    expect(before.toc).toEqual(['1. 개요', '2. 선수단'])
    expect(before.view.source).toContain("'''가람고등학교'''(가람고)의 농구부. [[테스트 리그]] 동 컨퍼런스 북 디비전 소속.")
    for (const title of ['== 상세 ==', '== 향후 전망 ==', '== 여담 ==']) expect(before.view.source).toContain(title)
    startSeason(db)
    playRound1()
    const after = shown('가람고')
    expect(after.toc).toEqual(['1. 개요', '2. 선수단', '3. 시즌별 성적', '4. 최근 경기'])
    const box = after.view.data.infobox!
    expect(box.title).toBe('가람고등학교 농구부')
    expect(box.rows.map((r) => r.label)).toEqual(['소속', '팀 컬러', '이번 시즌'])
    expect(box.rows[0]).toMatchObject({ value: '테스트 리그 동 컨퍼런스 · 북 디비전', link: '테스트 리그' })
    expect(box.rows[1]!.swatches).toEqual(['#1d4ed8', '#facc15'])
    expect(box.colors).toEqual(['#1d4ed8', '#facc15'])
    expect(box.rows[2]!.value).toMatch(/^1승 0패 \(\d위\)$/)
    // Its season: place among the schools, no playoffs yet, the record.
    expect(after.view.data.record?.columns).toEqual(['시즌', '순위', '플레이오프', '승', '패', '승률'])
    expect(after.view.data.record?.rows[0]?.cells).toEqual(['시즌 1', expect.stringMatching(/^\d위\/8팀$/), '', '1', '0', '1.000'])
  })

  it('shows its roster with Korean positions, heights in cm and Korean rating names', () => {
    wiki.ensure(db, dir, true)
    const view = wiki.page(db, dir, '가람고')
    const roster = view.data.roster!
    expect(roster.columns).toEqual(['이름', '포지션', '신장', '종합', '운동 능력', '골밑 수비', '3점 슛'])
    expect(roster.rows[0]!.cells).toEqual(['가가가', '포인트 가드', '185cm', '70', 'A+', 'D', 'B'])
    expect(roster.rows.at(-1)!.cells[1]).toBe('벤치 멤버')
    expect(roster.grades).toEqual([4, 5, 6])
    expect(roster.hints).toEqual([null, null, null, 'OVR', 'Athleticism', 'Inside D', '3pt'])
  })
})

describe('pages from before the Korean layout', () => {
  /** A player page as the old seeder wrote it. */
  const OLD = (name: string) =>
    [
      '[목차]',
      '== 개요 ==',
      `'''${name}'''은 [[가람고]] 소속 PG 선수다.`,
      '== 플레이 스타일 ==',
      'Athleticism(A+)이 강점으로 꼽힌다.',
      ' * Athleticism: A+',
      ' * Inside D: D',
      '== 시즌별 활약 ==',
      '[기록]',
      '== 역사 ==',
      '[역사]',
      '== 여담 ==',
      '[각주]',
      '[[분류:가람고 선수]]',
      '[[분류:선수]]',
    ].join('\n')
  const plant = (id: string, name: string) => saveRevision(db, { title: name, kind: 'player', refId: id, body: OLD(name), authorId: SYSTEM, summary: '문서 생성' }, 1)
  /** A school page as the old seeder wrote it. */
  const OLD_SCHOOL = [
    '[목차]',
    '== 개요 ==',
    "'''가람고등학교'''(가람고)는 [[테스트 리그]]의 동 북에 속한 학교다.",
    '== 로스터 ==',
    '[정보]',
    '== 시즌별 성적 ==',
    '[기록]',
    '== 최근 경기 ==',
    '[최근경기]',
    '== 여담 ==',
    '[각주]',
    '[[분류:동]]',
    '[[분류:학교]]',
  ].join('\n')

  it('are brought up to it once, keeping what you and the editors wrote', () => {
    plant('p1', '가가가')
    plant('p2', '가나나')
    plant('p3', '가다다')
    saveRevision(db, { title: '가람고', kind: 'team', refId: 't1', body: OLD_SCHOOL, authorId: SYSTEM, summary: '문서 생성' }, 1)
    // You rewrote 가나나's 플레이 스타일; an editor added a line under 가다다's list.
    saveRevision(db, { title: '가나나', body: OLD('가나나').replace(/== 플레이 스타일 ==\n[^=]*/, '== 플레이 스타일 ==\n내가 쓴 설명.\n'), authorId: 'me', summary: '' }, 2)
    saveRevision(db, { title: '가다다', body: OLD('가다다').replace(' * Inside D: D', ' * Inside D: D\n돌파는 리그 정상급이다.'), authorId: 'f001', summary: '' }, 3)
    expect(upgradeWiki(db, Date.now())).toBe(4)
    // Untouched: the seeded lines go (the page shows the app's text there); his career comes before how he plays, then his ties.
    expect(section('p1', '개요')).toBe('')
    expect(section('p1', '플레이 스타일')).toBe('')
    expect(bodyOf('p1')).toBe(
      ['[목차]', '== 개요 ==', '== 시즌별 활약 ==', '[기록]', '== 역사 ==', '[역사]', '== 플레이 스타일 ==', '== 인간관계 ==', '[인간관계]', '== 여담 ==', '[각주]', '[[분류:가람고 선수]]', '[[분류:선수]]'].join('\n'),
    )
    expect(wiki.history(db, '가가가')[0]).toMatchObject({ summary: '문서 양식 갱신', author: { kind: 'system' } })
    // Yours stays yours (moved, not changed); the editor's line stays, the seeded list goes.
    expect(section('p2', '플레이 스타일')).toBe('내가 쓴 설명.')
    expect(sectionsYouOwn(db, pageByRef(db, 'player', 'p2')!.id)).toEqual(new Set(['플레이 스타일']))
    expect(bodyOf('p2').indexOf('== 플레이 스타일 ==')).toBeGreaterThan(bodyOf('p2').indexOf('== 역사 =='))
    expect(section('p3', '플레이 스타일')).toBe('돌파는 리그 정상급이다.')
    expect(section('p3', '개요')).toBe('')
    // The school: 상세 after 개요, 로스터 is 선수단, 향후 전망 before 여담; its 개요 as it was.
    const school = pageByRef(db, 'team', 't1')!
    expect(revisionBody(db, school.id, school.currentRev!)!.body).toBe(
      OLD_SCHOOL.replace('== 로스터 ==', '== 상세 ==\n== 선수단 ==').replace('== 여담 ==', '== 향후 전망 ==\n== 여담 =='),
    )
    // Once.
    expect(upgradeWiki(db, Date.now())).toBe(0)
  })
})

describe('AI-written player pages', () => {
  it('get a 플레이 스타일 after a round, from Korean labels and public lore only, saved as an editor’s revision', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    playRound1()
    story.afterChange('test', db, dir)
    const jobs = playerJobs()
    expect(jobs.length).toBeGreaterThan(0)
    const job = jobs.find((j) => j.input.targets.some((t) => t.playerId === 'p1'))!
    expect(job.priority).toBe(WIKI_PLAYER_PRIORITY)
    expect(WIKI_PLAYER_PRIORITY).toBeLessThan(STORY_PRIORITY.chatter_batch)
    const context = job.input.context
    // Grades in Korean, each with the word prose puts it in.
    expect(context).toContain('운동 능력 A+(리그 최정상급)')
    expect(context).toContain('골밑 수비 D(약점)')
    expect(context).toContain('종합 70')
    expect(context).toContain('포인트 가드')
    expect(context).toContain('팀 안의 역할: 주전')
    expect(context).toContain('신장 185cm')
    expect(context).toContain('3점슛이 주무기다')
    expect(context).toContain('1경기 평균 31.0점')
    expect(context).toContain('비교할 만한 리그 선수')
    for (const word of ['Athleticism', 'Inside D', RUMOR, SECRET]) expect(context).not.toContain(word)
    expect(job.input.targets.find((t) => t.playerId === 'p1')).toMatchObject({ need: 'new', overview: true })
    await drain()
    expect(playerJobs().find((j) => j.id === job.id)?.status).toBe('done')
    // One revision under an editor, with both sections; history shows it; a mark keeps what it was written from.
    const history = wiki.history(db, titleOf('p1'))
    expect(history[0]).toMatchObject({ summary: '플레이 스타일 서술' })
    expect(job.input.editors).toContain(history[0]!.author.id)
    expect(section('p1', '플레이 스타일')).toContain('운동 능력')
    expect(section('p1', '개요')).toContain('포인트 가드')
    expect(JSON.parse(storyValue(db, 'wiki-style:p1')!)).toMatchObject({ rev: history[0]!.rev, sections: ['플레이 스타일', '개요'] })
    // Written: nothing more to do until its ratings or lore change.
    expect(pageNeed(db, readLeague(db, dir), listPlayers(db).find((p) => p.id === 'p1')!)).toBeNull()
  })

  it('are written again when his ratings or his lore’s play sentences change, never over your text', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    playRound1()
    story.afterChange('test', db, dir)
    await drain()
    const written = section('p1', '플레이 스타일')
    const need = () => pageNeed(db, readLeague(db, dir), listPlayers(db).find((p) => p.id === 'p1')!)?.need ?? null
    // A lore line that isn't about how he plays: nothing to do.
    loreFile('가람고', '가가가', `---\nid: 가가가\n---\n## 공개\n빠른 발로 코트를 가른다. 3점슛이 주무기다.\n여름이면 할머니 댁에 간다.\n`)
    expect(need()).toBeNull()
    // A play sentence: stale.
    loreFile('가람고', '가가가', `---\nid: 가가가\n---\n## 공개\n빠른 발로 코트를 가른다. 돌파가 주무기다.\n`)
    expect(need()).toBe('stale')
    // Your rating edit queues the rewrite at once (the lore change waits for the next round).
    transaction(db, () => updatePlayers(db, [{ playerId: 'p1', ratings: { ind: 'A' } }]))
    story.afterChange('test', db, dir)
    const again = playerJobs().at(-1)!
    expect(['queued', 'running']).toContain(again.status)
    expect(again.input.targets.map((t) => [t.playerId, t.need])).toEqual([['p1', 'stale']])
    expect(again.input.context).toContain('다시 쓴다')
    expect(again.input.context).toContain('골밑 수비 A')
    await drain()
    expect(section('p1', '플레이 스타일')).not.toBe(written)
    expect(need()).toBeNull()
    // You write the section yourself: a later change never brings the AI back to it.
    const page = pageByRef(db, 'player', 'p1')!
    wiki.save(db, { title: page.title, source: bodyOf('p1').replace(/== 플레이 스타일 ==\n[\s\S]*?\n(?=== 인간관계)/, '== 플레이 스타일 ==\n내가 쓴 플레이 스타일.\n'), summary: '', baseRev: page.currentRev })
    transaction(db, () => updatePlayers(db, [{ playerId: 'p1', ratings: { ind: 'C' } }]))
    const before = playerJobs().length
    story.afterChange('test', db, dir)
    expect(playerJobs()).toHaveLength(before)
    expect(section('p1', '플레이 스타일')).toBe('내가 쓴 플레이 스타일.')
  })

  it('come from 선수 문서 다듬기 in batches of about six a school, below chatter, and 취소 takes them back', () => {
    // Runs never answer, so the queue holds them for the test to look at.
    process.env.TWOK_FAKE_HOLD = WIKI_PLAYER
    const plan = story.playerPagesPlan(db, dir)
    expect(plan).toEqual({ players: 48, jobs: 8 })
    expect(story.polishPlayerPages('test', db, dir)).toEqual({ players: 48, jobs: 8 })
    const jobs = playerJobs()
    expect(jobs).toHaveLength(8)
    for (const j of jobs) {
      expect(j.priority).toBe(WIKI_PLAYER_PRIORITY)
      expect(j.input.targets.length).toBeLessThanOrEqual(6)
      expect(new Set(j.input.targets.map((t) => listPlayers(db).find((p) => p.id === t.playerId)!.teamId)).size).toBe(1)
    }
    // Everyone is in a job already: a second go has nothing to add.
    expect(story.playerPagesPlan(db, dir)).toEqual({ players: 0, jobs: 0 })
    expect(story.polishPlayerPages('test', db, dir)).toEqual({ players: 0, jobs: 0 })
    const status = story.playerPagesStatus(db)
    expect(status.waiting + status.running).toBe(8)
    // 취소: every waiting one goes (the one running finishes, or is cancelled by itself).
    expect(ai.cancelWaiting('test', db, dir, WIKI_PLAYER).cancelled).toBe(status.waiting)
    const running = playerJobs().filter((j) => j.status === 'running')
    for (const j of running) ai.cancel('test', db, dir, j.id)
    expect(story.playerPagesStatus(db)).toEqual({ waiting: 0, running: 0 })
    expect(playerJobs().every((j) => j.status === 'cancelled')).toBe(true)
    // Cancelled, they can be asked for again.
    expect(story.playerPagesPlan(db, dir).players).toBe(48)
  })

  it('keep the round’s editors out of an empty 개요 and 플레이 스타일', () => {
    wiki.ensure(db, dir, true)
    const name = titleOf('p2')
    const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_edits', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    const edit = (section: string) => ({ page: name, section, mode: 'append' as const, text: `${section}에 덧붙임.`, summary: '편집', editor: 'f001' })
    wikiEditKind(db).accept!({ edits: [edit('개요'), edit('플레이 스타일'), edit('여담')], disputes: [] }, { id, input: { pages: [name], editors: ['f001'], context: '', instructions: '' } } as unknown as JobRow)
    expect(section('p2', '개요')).toBe('')
    expect(section('p2', '플레이 스타일')).toBe('')
    expect(section('p2', '여담')).toBe('여담에 덧붙임.')
  })

  it('are redone once over a number the facts don’t hold, then kept with it marked', () => {
    wiki.ensure(db, dir, true)
    const requeued: WikiPlayerInput[] = []
    const kind = wikiPlayerKind(db, () => null, { requeue: (input) => void requeued.push(input) })
    const league = readLeague(db, dir)
    const input = playerPagesInput(league, planPlayerPages(league, { fresh: ['p1'], stale: null }), 'test')!
    const out = { pages: [{ target: 'P1', playStyle: '경기당 47점을 넣는 괴물이다.', overview: null, editor: input.editors[0]!, summary: '서술' }] }
    const run = (i: WikiPlayerInput) => {
      const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES (?, 'done', '{}', ?)").run(WIKI_PLAYER, new Date().toISOString()).lastInsertRowid)
      kind.accept!(out, { id, input: i, createdAt: new Date().toISOString() } as unknown as JobRow)
      return id
    }
    run(input)
    // Nothing landed; the same job again, with the numbers.
    expect(section('p1', '플레이 스타일')).toBe('')
    expect(requeued).toHaveLength(1)
    expect(requeued[0]!.numberRetry).toEqual(['47점'])
    run(requeued[0]!)
    expect(section('p1', '플레이 스타일')).toBe('경기당 47점을 넣는 괴물이다.')
    expect(wiki.history(db, titleOf('p1'))[0]!.flags).toEqual(['47점'])
  })
})
