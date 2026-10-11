// End-to-end: building rounds by hand, on the made-up example league (8 teams, a double round
// robin: 14 rounds of 4 games). Picks 라운드마다 직접 in the wizard, starts the season with no
// games, builds round 1 by clicking (home school, then its opponent), flips and removes a game,
// fills the rest with 자동 채우기, plays it, checks 경기일 asks for the next round, then builds and
// plays the whole season and checks the playoff button only appears at the very end.
// Run `npm run build` first. Uses a fresh temp data folder and no AI.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-schedule-'))
const outDir = join(root, 'out', 'e2e')
mkdirSync(outDir, { recursive: true })
console.log('data folder:', dataDir)
const shot = async (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: [root],
  env: { ...process.env, TWOK_DATA_DIR: dataDir, TWOK_NO_AI: '1' },
})
const logs = []
const page = await app.firstWindow()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('dialog', (d) => d.accept())
await page.setViewportSize({ width: 1440, height: 920 })
const invoke = (channel, ...args) =>
  page.evaluate(async ([c, a]) => {
    const r = await window.twok.invoke(c, ...a)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }, [channel, args])
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    console.log('FAIL', name, String(e).slice(0, 400))
    await shot(page, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}
const expectEq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
const play = async (games) => {
  for (const g of games) await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 80, awayScore: 70, lines: null })
}
let slug = ''
const regular = async (round) => (await invoke('season.games', slug)).filter((g) => g.stage === 'regular' && (round === undefined || g.round === round))

await step('create the example league, building rounds by hand', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("시즌")')
  await page.click('button:has-text("라운드마다 직접")')
  await page.waitForSelector('text=라운드마다 누가 누구와 붙을지')
  await page.click('.stepper button:has-text("확인")')
  await page.waitForSelector('text=라운드마다 직접')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])
})

await step('start the season with no games', async () => {
  await page.waitForSelector('text=라운드마다 대진을 짤 수 있고')
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
  expectEq(await regular(), [], 'games at season start')
  expectEq(await invoke('schedule.info', slug), { build: 'manual', rounds: 14, perRound: 4, total: 56, played: 0, editable: true }, 'schedule info')
  if (await page.locator('button:has-text("플레이오프 시작")').count()) throw new Error('playoff button shown at season start')
})

await step('build round 1 by clicking: home school, then its opponent', async () => {
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.round-builder')
  if ((await page.locator('.round-tabs button.empty').count()) !== 14) throw new Error('every round should start empty')
  await shot(page, 'sc01-empty-round')
  const chips = page.locator('.round-builder .team-chip')
  const home = (await chips.nth(0).textContent()).trim()
  await chips.nth(0).click()
  await page.waitForSelector('.round-builder .team-chip.ok')
  await shot(page, 'sc02-picking')
  await page.locator('.round-builder .team-chip.ok').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 1)
  const [g] = await regular(1)
  const teams = await invoke('leagues.snapshot', slug)
  if (teams.teams.find((t) => t.id === g.home).shortName !== home) throw new Error('the first school picked should host')
  // ⇄ swaps home and away; ✕ takes the game out again.
  await page.locator('.game-line button[title="홈/원정 바꾸기"]').click()
  await page.waitForTimeout(400)
  const [flipped] = await regular(1)
  expectEq([flipped.home, flipped.away], [g.away, g.home], 'flipped game')
  await page.locator('.game-line button[title="경기 빼기"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 0)
  if ((await page.locator('.round-tabs button.partial').count()) !== 0) throw new Error('an empty round is not partial')
})

await step('자동 채우기 completes a half-built round', async () => {
  const chips = page.locator('.round-builder .team-chip')
  await chips.nth(0).click()
  await page.waitForSelector('.round-builder .team-chip.ok')
  await page.locator('.round-builder .team-chip.ok').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 1)
  await page.waitForSelector('.round-tabs button.partial')
  await page.click('.round-builder button:has-text("자동 채우기")')
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 4)
  await page.waitForSelector('text=이 라운드 대진을 다 짰어요')
  await shot(page, 'sc03-round-built')
})

await step('play round 1; 경기일 then asks for the next round', async () => {
  await play(await regular(1))
  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('text=다음 라운드 대진을 먼저 짜세요')
  await page.click('a:has-text("일정에서 대진 짜기")')
  await page.waitForSelector('.round-builder')
  if ((await page.locator('.round-tabs button.done').count()) !== 1) throw new Error('round 1 should be done')
})

await step('in a double round robin, a pair that met once can meet again; the school picked hosts', async () => {
  // Round 2 is shown (the first unfinished round). Round 1's pairs still owe a second meeting.
  const [first] = await regular(1)
  const snap = await invoke('leagues.snapshot', slug)
  const name = (id) => snap.teams.find((t) => t.id === id).shortName
  // A chip reads "<school>" or "<school> 홈n·원n": match the school name exactly.
  const chip = (id) => page.locator('.round-builder .team-chip').filter({ hasText: new RegExp(`^${name(id)}(\\s|$)`) })
  await chip(first.away).click()
  await page.waitForSelector('.round-builder .team-chip.ok')
  const opponent = chip(first.home)
  if (!(await opponent.getAttribute('class')).includes('ok')) throw new Error('a second meeting should be allowed')
  await opponent.click()
  await page.waitForFunction(() => document.querySelectorAll('.game-line').length === 1)
  const [g] = await regular(2)
  expectEq([g.home, g.away], [first.away, first.home], 'second meeting at the other school')
})

await step('a school picked in one round is let go when another round opens', async () => {
  await page.locator('.round-builder .team-chip').first().click()
  await page.waitForSelector('.round-builder .team-chip.on')
  await page.click('.round-tabs button:has-text("3")')
  await page.waitForSelector('.round-builder')
  if (await page.locator('.round-builder .team-chip.on').count()) throw new Error('the pick carried over to round 3')
  if ((await page.locator('.round-builder .team-chip:disabled').count()) !== 0) throw new Error('round 3 chips should be free to pick')
})

await step('경기일 links to typing a game in by hand, on its round', async () => {
  await page.click('.nav a:has-text("경기일")')
  await page.click('a:has-text("스크린샷 없이 직접 입력")')
  await page.waitForSelector('.game-line input.score')
  await page.waitForSelector('.round-tabs button.on:has-text("2")')
})

await step('build and play the whole double round robin; playoffs only at the end', async () => {
  for (let r = 2; r <= 14; r++) {
    const before = (await regular(r)).length
    const { added } = await invoke('schedule.fill', slug, r)
    if (before + added !== 4) throw new Error(`round ${r}: ${before} built, ${added} filled`)
    if (r < 14) await play(await regular(r))
    else {
      const games = await regular(r)
      await play(games.slice(0, 3))
      await page.click('.nav a:has-text("리그 사무국")')
      await page.waitForSelector('text=경기 결과 입력')
      if (await page.locator('button:has-text("플레이오프 시작")').count()) throw new Error('playoff button before the last game')
      await play(games.slice(3))
    }
  }
  // Every pair met twice, once at each school.
  const all = await regular()
  const hosts = new Map()
  for (const g of all) {
    const key = [g.home, g.away].sort().join('-')
    hosts.set(key, [...(hosts.get(key) ?? []), g.home])
  }
  if (all.length !== 56 || hosts.size !== 28 || [...hosts.values()].some((h) => new Set(h).size !== 2)) throw new Error('not a double round robin, once at each school')
  await page.reload()
  await page.waitForSelector('button:has-text("플레이오프 시작")')
  await shot(page, 'sc04-season-done')
})

await app.close()
console.log('schedule e2e passed')
