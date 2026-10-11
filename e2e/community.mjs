// End-to-end: the community with the demo writer (TWOK_FAKE_AI=1). Creates the
// made-up example league, starts the season and records a game, then checks
// the post-game thread and the season notice appear, opens the thread (a
// double-click votes once), uses refresh (chatter refill and reveal), writes a
// post and a comment and gets replies, posts news, tries bad addresses and the
// narrowest window, and opens the lore screen (broken files, a traded player's
// file that can't follow him yet). Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-cm-'))
const outDir = join(root, 'out', 'e2e')
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: [root],
  env: { ...process.env, TWOK_DATA_DIR: join(dataDir, 'data'), TWOK_FAKE_AI: '1' },
})
const logs = []
const page = await app.firstWindow()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('dialog', (d) => d.accept())
await page.setViewportSize({ width: 1440, height: 920 })
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const invoke = (channel, ...args) =>
  page.evaluate(async ([c, a]) => {
    const r = await window.twok.invoke(c, ...a)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }, [channel, args])
const until = async (what, fn, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out: ${what}`)
}
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    console.log('FAIL', name, String(e).slice(0, 400))
    await shot(`cm-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}

await step('create, start and record a game', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  // The community's first look sets its mark, so a league made earlier doesn't get old news.
  await page.click('.nav a:has-text("커뮤니티")')
  await page.waitForSelector('.cm-table')
  await page.click('.nav a:has-text("리그 사무국")')
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
})
const slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])

await step('a post-game thread and the season notice appear', async () => {
  const games = await invoke('season.games', slug)
  const g = games.find((x) => x.status === 'scheduled')
  await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 88, awayScore: 84, lines: null })
  await until('both story jobs written', async () => (await invoke('community.status', slug)).writing === 0)
  await page.click('.nav a:has-text("커뮤니티")')
  await page.click('.cm-board:has-text("경기 결과")')
  await page.waitForSelector('.cm-title:has-text("[경기 후]")')
  await page.click('.cm-board >> nth=0')
  await page.waitForSelector('.cm-title:has-text("개막")')
  await shot('cm01-main-board')
})

await step('a new game thread shows up on the open board by itself, without refresh', async () => {
  await page.click('.cm-board:has-text("경기 결과")')
  await page.waitForSelector('.cm-title:has-text("[경기 후]")')
  const threads = () => page.locator('.cm-title:has-text("[경기 후]")').count()
  const before = await threads()
  const g = (await invoke('season.games', slug)).find((x) => x.status === 'scheduled')
  await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 77, awayScore: 70, lines: null })
  // The list only reloads when told to: the finished writer's note is what brings the thread in (within 8 s).
  await until('the new thread on the open list', async () => (await threads()) > before, 40)
})

/** Waits until a post has at least `n` visible comments (asking the app, not the screen). */
const commentsOn = async (postId, n, what) =>
  until(what, async () => (await invoke('community.post', slug, postId)).thread.length >= n, 150)
const postOn = async (board, title) => (await invoke('community.board', slug, board, 1)).posts.find((p) => p.title.includes(title))

await step('open the thread; comments trickle in', async () => {
  const thread = await postOn('games', '[경기 후]')
  await commentsOn(thread.id, 3, 'comments visible')
  await page.click('.cm-board:has-text("경기 결과")')
  await page.click('.cm-title:has-text("[경기 후]")')
  await page.waitForSelector('.cm-comments .cm-comment >> nth=2')
  await page.click('.cm-vote.up')
  await page.waitForSelector('.cm-vote.up.on')
  // A double-click is one vote, not a vote and its undo (on the post and on a comment).
  await page.dblclick('.cm-vote.down')
  await page.waitForSelector('.cm-vote.down.on[aria-pressed="true"]')
  await page.dblclick('.cm-comments .cm-comment >> nth=0 >> .cm-mini >> nth=0')
  await page.waitForSelector('.cm-comments .cm-comment >> nth=0 >> .cm-mini.on[aria-pressed="true"]')
  await new Promise((r) => setTimeout(r, 500))
  const voted = await invoke('community.post', slug, thread.id)
  if (voted.myVote !== -1) throw new Error(`post vote after a double-click: ${voted.myVote}`)
  if (voted.thread[0].myVote !== 1) throw new Error(`comment vote after a double-click: ${voted.thread[0].myVote}`)
  await shot('cm02-thread')
})

await step('refresh refills chatter, then reveals it', async () => {
  await page.click('.cm-board >> nth=0')
  await page.click('button:has-text("새로고침")')
  await page.waitForSelector('.cm-note')
  await until('chatter written', async () => (await invoke('community.status', slug)).waiting > 0)
  await page.click('button:has-text("새로고침")')
  await until('chatter revealed', async () => (await page.locator('.cm-note').innerText()).includes('새 글·댓글'))
  await shot('cm03-after-refresh')
})

/** Opens a post by its address (board and id), as a link would. */
const openPost = async (boardId, postId) => {
  await page.evaluate((h) => void (location.hash = h), `#/l/${encodeURIComponent(slug)}/community?b=${boardId}&post=${postId}`)
  await page.waitForSelector('.cm-post h1')
}
let fansPoll = null

await step('a fans’ poll fills up; you vote, then change your vote', async () => {
  // The demo chatter's first post always carries a poll.
  fansPoll = (await invoke('community.latest', slug)).find((p) => p.pollState === 'open')
  if (!fansPoll) throw new Error('no open poll after refresh')
  await page.evaluate((h) => void (location.hash = h), `#/l/${encodeURIComponent(slug)}/community?b=${fansPoll.boardId}`)
  await page.waitForSelector('.cm-table .cm-poll-tag')
  await openPost(fansPoll.boardId, fansPoll.id)
  await page.waitForSelector('.cm-poll .cm-poll-option >> nth=1')
  // Fans' votes show up over time, the first ones within seconds.
  await until('fans’ votes come in', async () => (await invoke('community.post', slug, fansPoll.id)).poll.total > 0, 300)
  await page.click('.cm-poll-option >> nth=0 >> button')
  await page.waitForSelector('.cm-poll-option.mine >> nth=0')
  await page.click('.cm-poll-option >> nth=1 >> button:has-text("이걸로 바꾸기")')
  await until('the vote moved', async () => (await invoke('community.post', slug, fansPoll.id)).poll.myVote === 1)
  await page.waitForSelector('.cm-poll-option.mine:has-text("내 선택")')
  if ((await page.locator('.cm-poll-option.mine').count()) !== 1) throw new Error('more than one option marked as yours')
  await shot('cm03b-poll')
})

await step('your post can carry a poll', async () => {
  await page.click('.cm-board:has-text("자유")')
  await page.click('button:has-text("글쓰기")')
  await page.fill('.cm-write input', '이번 라운드 승부처')
  await page.fill('.cm-write textarea', '어디서 갈릴까')
  await page.click('.cm-write button:has-text("투표 추가")')
  const fields = page.locator('.cm-poll-edit input')
  await fields.nth(0).fill('어느 쪽이 웃을까?')
  await fields.nth(1).fill('홈')
  await page.waitForSelector('.cm-poll-edit .sub:has-text("2개 이상")')
  if (await page.locator('.cm-write button:has-text("등록")').isEnabled()) throw new Error('a poll with one option can be posted')
  await fields.nth(2).fill('원정')
  await page.click('.cm-write button:has-text("등록")')
  await page.waitForSelector('.cm-post .cm-poll .cm-poll-q:has-text("어느 쪽이 웃을까?")')
})

await step('the next finished round closes the polls and posts the results', async () => {
  const round = (await invoke('community.post', slug, fansPoll.id)).poll.closesAfterRound
  if (round === null) throw new Error('a poll in the regular season should wait for a round')
  const games = (await invoke('season.games', slug)).filter((g) => g.status === 'scheduled' && g.stage === 'regular' && g.round <= round)
  for (const g of games) await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 80, awayScore: 72, lines: null })
  await until('the poll closed', async () => !(await invoke('community.post', slug, fansPoll.id)).poll.open, 150)
  await openPost(fansPoll.boardId, fansPoll.id)
  await page.waitForSelector('.cm-poll.closed .cm-poll-final')
  await page.click('.cm-poll button:has-text("결과 글 보기")')
  await page.waitForSelector('.cm-post h1:has-text("[투표 결과]")')
  await shot('cm03c-poll-results')
  await page.click('button:has-text("투표 글로 가기")')
  await page.waitForSelector('.cm-poll.closed')
  await until('every writer done', async () => (await invoke('community.status', slug)).writing === 0, 300)
})

await step('a number its facts didn’t hold is marked, for you only', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const leagues = join(dataDir, 'data')
  const folder = readdirSync(leagues).find((s) => existsSync(join(leagues, s, 'league.sqlite')))
  const db = new DatabaseSync(join(leagues, folder, 'league.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    // The demo writer only uses numbers from its facts: nothing was redone or marked.
    const redone = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(input, '$.numberRetry') IS NOT NULL").get().n
    const marked = db.prepare('SELECT COUNT(*) AS n FROM ai_flags').get().n
    if (redone || marked) throw new Error(`demo writing was redone ${redone} times and marked ${marked} times`)
    const thread = await postOn('games', '[경기 후]')
    // A comment with a number if there is one, else the post itself (its headline has the score).
    const view = await invoke('community.post', slug, thread.id)
    const comment = view.thread.find((c) => /\d{2,}/.test(c.body))
    const target = comment ? { kind: 'comment', id: comment.id, text: comment.body, at: '.cm-comments .ai-number' } : { kind: 'post', id: thread.id, text: `${view.title}\n${view.body}`, at: '.cm-post .ai-number' }
    const found = target.text.match(/\d{2,}/)
    if (!found) throw new Error('no number to mark')
    const number = found[0]
    db.prepare('INSERT INTO ai_flags (target_kind, target_id, numbers, job_id, created_at) VALUES (?, ?, ?, NULL, ?)').run(
      target.kind,
      target.id,
      JSON.stringify([number]),
      new Date().toISOString(),
    )
    await openPost(thread.boardId, thread.id)
    const mark = page.locator(target.at).first()
    await mark.waitFor()
    if ((await mark.innerText()).trim() !== number) throw new Error(`marked ${await mark.innerText()}, expected ${number}`)
    if ((await mark.getAttribute('title')) !== '자료에 없는 숫자예요') throw new Error(`mark title: ${await mark.getAttribute('title')}`)
    await shot('cm03d-number-mark')
  } finally {
    db.close()
  }
})

await step('your post and comment get replies', async () => {
  await page.click('.cm-board:has-text("자유")')
  await page.click('button:has-text("글쓰기")')
  await page.fill('.cm-write input', '이번 시즌 우승 예상')
  await page.fill('.cm-write textarea', '다들 어디 봄?')
  await page.click('.cm-write button:has-text("등록")')
  await page.waitForSelector('.cm-post h1:has-text("이번 시즌 우승 예상")')
  const mine = await postOn('free', '이번 시즌 우승 예상')
  await commentsOn(mine.id, 2, 'replies to the post')
  // The open page keeps looking while the reply is written (nothing is pending until it's done): no reload needed.
  const shown = () => page.locator('.cm-comments .cm-comment').count()
  await until('replies on the open page', async () => (await shown()) >= 2, 300)
  await page.fill('.cm-form textarea', '나는 첫 경기 이긴 팀')
  await page.click('button:has-text("댓글 등록")')
  await page.waitForSelector('.cm-comment.mine')
  const before = await shown()
  await until('replies to the comment on the open page', async () => (await shown()) > before, 300)
  await until('a reply to the comment', async () => (await invoke('community.post', slug, mine.id)).thread.some((c) => c.parentId !== null && !c.mine), 150)
  await page.click('.cm-crumb button')
  await page.click('.cm-title:has-text("이번 시즌 우승 예상")')
  await page.waitForSelector('.cm-comment.reply')
  await shot('cm04-my-post')
})

await step('news becomes an article', async () => {
  await page.click('.cm-board >> nth=0')
  await page.fill('.cm-news textarea', '감독 경질설이 돌고 있다')
  await page.click('button:has-text("뉴스 올리기")')
  await page.waitForSelector('text=뉴스를 올렸어요')
  await until('news thread written', async () => (await invoke('community.status', slug)).writing === 0)
  await page.click('.cm-board:has-text("자유")')
  await page.click('.cm-board >> nth=0')
  await page.waitForSelector('.cm-title:has-text("감독 경질설")')
})

await step('bad addresses fall back', async () => {
  const main = (await invoke('leagues.snapshot', slug)).config.community.boards.find((b) => b.role === 'main')
  const open = (query) => page.evaluate((h) => void (location.hash = h), `#/l/${encodeURIComponent(slug)}/community?${query}`)
  const at = (query) => until(`address ${query}`, async () => page.url().endsWith(`/community?${query}`))
  // An unknown board, a page that isn't a number and a post id that isn't one: the main board, tidied.
  await open('b=nope&p=abc&post=-3')
  await page.waitForSelector(`.cm-list h2:has-text("${main.name}")`)
  await at(`b=${main.id}`)
  // Past the last page: the last page, and the address follows.
  await open('b=free&p=999')
  await page.waitForSelector('.cm-list h2:has-text("자유")')
  await at('b=free')
  // A post that isn't there says so, with a way back.
  await open('b=free&post=999999')
  await page.waitForSelector('text=글을 찾을 수 없어요')
  await page.click('.cm-crumb button')
  await page.waitForSelector('.cm-table')
})

await step('a narrow window keeps titles readable', async () => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.click('.cm-board >> nth=0')
  await page.waitForSelector('.cm-table')
  // Measured once the list has settled: the board's click redraws it, and a row being replaced measures 0.
  let width = 0
  const titleWidth = () => page.evaluate(() => document.querySelector('.cm-table th.title')?.getBoundingClientRect().width ?? 0)
  await until('the title column to settle at 300px or more', async () => (width = await titleWidth()) >= 300, 25).catch(() => {
    throw new Error(`title column only ${Math.round(width)}px wide`)
  })
  await shot('cm06-narrow')
  await page.setViewportSize({ width: 1440, height: 920 })
})

await step('settings rename a board', async () => {
  await page.click('.nav a:has-text("편집실")')
  await page.waitForSelector('h2:has-text("커뮤니티 설정")')
  const card = page.locator('.card:has(h2:has-text("커뮤니티 설정"))')
  const save = card.locator('button:has-text("저장")')
  const field = card.locator('.field:has(label:has-text("유머")) input')
  // An empty name is caught on the form, in Korean, before anything is sent.
  await field.fill('')
  await card.locator('text=유머 게시판 이름을 입력하세요').waitFor()
  if (await save.isEnabled()) throw new Error('save is enabled with an empty board name')
  // Stray spaces are trimmed by the server; once saved, nothing is left to save.
  await field.fill(' 짤방 ')
  await card.locator('.field:has(label:has-text("내 닉네임")) input').fill('테스트유저 ')
  await save.click()
  await card.locator('text=저장했어요').waitFor()
  if (await save.isEnabled()) throw new Error('still unsaved changes after saving')
  if ((await field.inputValue()) !== '짤방') throw new Error(`the form kept "${await field.inputValue()}"`)
  await page.click('.nav a:has-text("커뮤니티")')
  await page.waitForSelector('.cm-board:has-text("짤방")')
})

await step('the lore screen opens and explains broken files in Korean', async () => {
  const team = join(dataDir, 'data', slug, 'lore', 'teams', '없는학교')
  mkdirSync(team, { recursive: true })
  writeFileSync(join(team, '없는학교.md'), '---\nid: 없는학교\nfans:\n  size: 9\n---\n## 공개\n')
  writeFileSync(join(team, '설정없음.md'), '# 설정 블록이 없는 파일\n')
  await page.click('.nav a:has-text("로어")')
  await page.waitForSelector('h1:has-text("로어")')
  await page.waitForSelector("text=설정 'fans.size'의 값이 맞지 않아요")
  await page.waitForSelector('text=--- 줄로 감싼 설정 블록이 없어요')
  await shot('cm05-lore')
})

await step('a traded player’s lore file follows him, or says why it can’t', async () => {
  const snap = await invoke('leagues.snapshot', slug)
  const [home, away] = snap.teams
  const player = snap.players.find((p) => p.teamId === home.id)
  const partner = snap.players.find((p) => p.teamId === away.id && p.slotId === player.slotId)
  const teams = join(dataDir, 'data', slug, 'lore', 'teams')
  const at = (team) => join(teams, team.shortName, `${player.name}.md`)
  mkdirSync(join(teams, home.shortName), { recursive: true })
  mkdirSync(join(teams, away.shortName), { recursive: true })
  writeFileSync(at(home), `---\nid: ${player.name}\n---\n## 공개\n떠도는 이야기.\n`)
  // A broken file already has his name at his new school, so his own can't move there yet.
  writeFileSync(at(away), '설정 없는 메모\n')
  await invoke('trades.apply', slug, [
    { kind: 'player', playerId: player.id, from: home.id, to: away.id },
    { kind: 'player', playerId: partner.id, from: away.id, to: home.id },
  ], '')
  await page.click('button:has-text("다시 읽기")')
  await page.waitForSelector('text=제 폴더로 옮기지 못한 파일 1개')
  await page.waitForSelector('text=같은 이름의 다른 파일이 있어요')
  await shot('cm06-lore-misplaced')
  rmSync(at(away))
  await page.click('button:has-text("다시 옮기기")')
  await page.waitForSelector('text=제 폴더로 옮기지 못한 파일', { state: 'detached' })
  if (!existsSync(at(away))) throw new Error('the file did not move')
  if (existsSync(at(home))) throw new Error('the old file is still there')
})

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) {
  console.log('page errors:\n' + errors.join('\n'))
  await app.close()
  process.exit(1)
}
await app.close()
console.log('community e2e passed')
