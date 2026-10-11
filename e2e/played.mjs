// End-to-end: 2K 일정대로 (no rounds), on the made-up example league (8 teams, a double round robin:
// 56 games), with the demo writer (TWOK_FAKE_AI=1). Picks 2K 일정대로 in the wizard, starts the season
// with no games, adds a game in 일정 by picking two schools (and flipping home/away), adds one on
// 경기일 and types it in by hand through 직접 입력 (its box score opens in 일정), records games out of
// step so schools' games played drift apart, checks 오늘 경기 끝 waits for an unplayed game (빼기
// takes it out), closes 1일차, checks its round-up is written ("1일차 정리"), then plays the rest
// of the season in uneven sessions and starts the playoffs (which closes the last session).
// Run `npm run build` first. Uses a fresh temp data folder.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-played-'))
const outDir = join(root, 'out', 'e2e')
mkdirSync(outDir, { recursive: true })
console.log('data folder:', dataDir)
const shot = async (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: [root],
  env: { ...process.env, TWOK_DATA_DIR: dataDir, TWOK_FAKE_AI: '1' },
})
const logs = []
const page = await app.firstWindow()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
// Every confirm (오늘 경기 끝, 플레이오프 시작) is accepted.
page.on('dialog', (d) => d.accept())
await page.setViewportSize({ width: 1440, height: 920 })
const invoke = (channel, ...args) =>
  page.evaluate(async ([c, a]) => {
    const r = await window.twok.invoke(c, ...a)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }, [channel, args])
const until = async (what, fn, tries = 150) => {
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
    await shot(page, `pl-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}
const expectEq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
let slug = ''
const regular = async () => (await invoke('season.games', slug)).filter((g) => g.stage === 'regular')
const nameOf = async () => {
  const snap = await invoke('leagues.snapshot', slug)
  return (id) => snap.teams.find((t) => t.id === id).shortName
}
/** The demo GMs may trade at a trade window: their moves are made in 2K at once, so games can be recorded. */
const settle2k = async () => {
  for (const c of await invoke('checklist.list', slug)) if (c.appliedAt === null) await invoke('checklist.apply', slug, c.id)
}
/** Records a score; a trade window's demo GMs may trade meanwhile, so moves waiting for 2K are made and it tries again. */
const record = async (gameId, homeScore, awayScore) => {
  for (let tries = 0; ; tries++) {
    await settle2k()
    try {
      return await invoke('season.recordScore', slug, { gameId, homeScore, awayScore, lines: null })
    } catch (e) {
      if (tries >= 5 || !String(e).includes('pending-2k-moves')) throw e
    }
  }
}
/** A game just played in 2K: added to the open session and recorded (the home school wins). */
const playPair = async (home, away) => {
  const { gameId, round } = await invoke('schedule.addPlayed', slug, { home, away })
  await record(gameId, 88, 80)
  return { gameId, round }
}
const gamesPlayed = async () => (await invoke('season.standings', slug)).overall.map((l) => l.wins + l.losses)

await step('create the example league, playing 2K 일정대로', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("시즌")')
  await page.click('button:has-text("2K 일정대로")')
  await page.waitForSelector('text=경기할 때마다 두 학교를 골라 기록해요')
  await shot(page, 'pl01-wizard')
  await page.click('.stepper button:has-text("확인")')
  await page.waitForSelector('text=2K 일정대로')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])
  // The community's first look sets its mark, so the league's later news gets written.
  await page.click('.nav a:has-text("커뮤니티")')
  await page.waitForSelector('.cm-table')
  await page.click('.nav a:has-text("리그 사무국")')
})

await step('start the season with no games and 1일차 open', async () => {
  await page.waitForSelector('text=두 학교를 골라 기록해요')
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
  expectEq(await regular(), [], 'games at season start')
  expectEq(await invoke('schedule.info', slug), { build: 'played', rounds: 1, perRound: 0, total: 56, played: 0, editable: true, session: 1 }, 'schedule info')
})

await step('일정: pick two schools (the first hosts), flip, and add the game to 1일차', async () => {
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.played-picker .team-chip')
  await page.waitForSelector('.round-tabs button.on:has-text("1일차")')
  const chips = page.locator('.played-picker .team-chip')
  const first = (await chips.nth(0).textContent()).trim()
  await chips.nth(0).click()
  await page.waitForSelector('text=의 상대를 고르세요')
  // Only schools with a meeting left show up (here: all the others), after the picked one.
  if ((await chips.count()) !== 8) throw new Error(`expected the pick and 7 opponents, got ${await chips.count()} chips`)
  await chips.nth(1).click()
  await page.waitForSelector('.played-staged')
  await shot(page, 'pl02-staged')
  await page.click('.played-picker button:has-text("홈/원정 바꾸기")')
  await page.click('.played-picker button:has-text("이 경기 추가")')
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 1)
  const [g] = await regular()
  const name = await nameOf()
  if (!first.startsWith(name(g.away))) throw new Error('flipped: the school picked first should be away')
  expectEq(g.round, 1, 'the game is in 1일차')
  // A double round robin: the pair has one meeting left.
  const pairs = await invoke('schedule.pairs', slug)
  expectEq(pairs.open[g.home].find((o) => o.teamId === g.away)?.left, 1, 'meetings left for the pair')
})

await step('경기일: add a game there, then type it in by hand through 직접 입력 (the box score opens)', async () => {
  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('.played-panel .team-chip')
  const before = (await regular()).length
  // A school with no game yet hosts, against its first possible opponent.
  const games = await regular()
  const busy = new Set(games.flatMap((g) => [g.home, g.away]))
  const name = await nameOf()
  const pairs = await invoke('schedule.pairs', slug)
  const host = pairs.teams.find((t) => !busy.has(t.teamId)).teamId
  await page.locator('.played-panel .team-chip').filter({ hasText: new RegExp(`^${name(host)}\\s`) }).click()
  await page.waitForSelector('text=의 상대를 고르세요')
  await page.locator('.played-panel .team-chip:not(.on)').first().click()
  await page.click('.played-panel button:has-text("이 경기 추가")')
  await until('the game added', async () => (await regular()).length === before + 1)
  const added = (await regular()).find((g) => g.home === host)
  // It's the game picked for recording now.
  await page.waitForFunction((id) => document.querySelector('select[aria-label="기록할 경기 선택"]')?.value === String(id), added.id)
  await page.waitForSelector('.pregame')
  await shot(page, 'pl03-gameday')
  await page.click('a:has-text("스크린샷 없이 직접 입력")')
  await page.waitForSelector('.box-editor')
  const line = page.locator('.game-line', { has: page.locator('.box-editor') })
  await line.locator('input.score').nth(0).fill('77')
  await line.locator('input.score').nth(1).fill('71')
  await line.locator('button:has-text("기록")').click()
  await until('typed in by hand', async () => (await regular()).find((g) => g.id === added.id).status === 'final')
})

await step('record games out of step: games played drift apart', async () => {
  const [first] = await regular()
  await record(first.id, 90, 84)
  // The first game's home school plays twice more tonight; others rest.
  const pairs = await invoke('schedule.pairs', slug)
  const busy = first.home
  for (const o of pairs.open[busy].filter((x) => x.left === 2).slice(0, 2)) await playPair(busy, o.teamId)
  const gp = await gamesPlayed()
  if (Math.max(...gp) < 3 || Math.min(...gp) !== 0) throw new Error(`games played should be uneven: ${gp}`)
  await page.click('.nav a:has-text("순위")')
  await page.waitForSelector('th:has-text("경기")')
  await page.waitForSelector('text=학교마다 치른 경기 수가 달라요')
  await shot(page, 'pl04-standings')
})

await step('오늘 경기 끝 waits for an unplayed game (빼기 takes it out), then closes 1일차', async () => {
  const pairs = await invoke('schedule.pairs', slug)
  const [home, list] = Object.entries(pairs.open).find(([, l]) => l.length > 0)
  await invoke('schedule.addPlayed', slug, { home, away: list[0].teamId })
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.played-end')
  await page.waitForSelector('text=아직 기록하지 않은 경기가 1개 있어요')
  if (!(await page.locator('.played-end button:has-text("오늘 경기 끝")').isDisabled())) throw new Error('오늘 경기 끝 should wait for the unplayed game')
  await shot(page, 'pl05-unplayed')
  const count = (await regular()).length
  await page.click('.played-unplayed button:has-text("빼기")')
  await until('the unplayed game taken out', async () => (await regular()).length === count - 1)
  await page.waitForSelector('.played-end button:has-text("오늘 경기 끝"):not([disabled])')
  await page.click('.played-end button:has-text("오늘 경기 끝")')
  await page.waitForSelector('text=1일차를 끝냈어요. 이제 2일차예요.')
  await page.waitForSelector('.round-tabs button.on:has-text("2일차")')
  await page.waitForSelector('.round-tabs button.done:has-text("1일차")')
  expectEq((await invoke('schedule.info', slug)).session, 2, 'the open session')
  await shot(page, 'pl06-closed')
})

await step('1일차’s round-up is written', async () => {
  await until(
    'a 1일차 정리 post on the main board',
    async () => (await invoke('community.board', slug, 'main', 1)).posts.some((p) => p.title.includes('1일차 정리')),
    300,
  )
})

await step('play the rest in uneven sessions; 플레이오프 시작 closes the last one', async () => {
  let session = 2
  for (let night = 0; ; night++) {
    const pairs = await invoke('schedule.pairs', slug)
    const open = Object.entries(pairs.open).filter(([, l]) => l.length > 0)
    if (open.length === 0) break
    // 3 to 9 games a night, whoever has a meeting left: some schools twice, others resting.
    const tonight = 3 + ((night * 5) % 7)
    for (let i = 0; i < tonight; i++) {
      const now = Object.entries((await invoke('schedule.pairs', slug)).open).filter(([, l]) => l.length > 0)
      if (now.length === 0) break
      const [home, list] = now[(night + i) % now.length]
      const { round } = await playPair(home, list[list.length - 1].teamId)
      if (round !== session) throw new Error(`game went into ${round}일차, not ${session}일차`)
    }
    const done = (await invoke('schedule.pairs', slug)).teams.every((t) => t.left === 0)
    if (!done) {
      await invoke('schedule.closeSession', slug)
      session++
    }
  }
  const gp = await gamesPlayed()
  if (gp.some((n) => n !== 14)) throw new Error(`every school plays 14: ${gp}`)
  await page.click('.nav a:has-text("리그 사무국")')
  await page.reload()
  await page.waitForSelector('button:has-text("플레이오프 시작")')
  await page.click('button:has-text("플레이오프 시작")')
  await page.waitForSelector('a:has-text("대진표")')
  const info = await invoke('schedule.info', slug)
  if (info.editable || info.build !== 'played' || info.rounds !== session) throw new Error(`after the playoffs start: ${JSON.stringify(info)}`)
  await until(
    `the last session’s round-up (${session}일차 정리)`,
    async () => (await invoke('community.board', slug, 'main', 1)).posts.some((p) => p.title.includes(`${session}일차 정리`)),
    300,
  )
  await shot(page, 'pl07-playoffs')
})

await app.close()
console.log('played e2e passed')
