// End-to-end: a whole season on the built-in (made-up) example league, in the
// built app. Creates the league from the template, starts the season, enters a
// score with a box score, gives a weekly award in each conference, trades,
// vetoes, applies a move in 2K, plays out the season and playoffs, runs the
// draft, gives a season award and exports to Excel.
// Then starts season 2 and looks back at season 1 (read only), and exports
// every season.
// Run `npm run build` first, then `npm run e2e`. Uses a fresh temp data folder.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-'))
const outDir = join(root, 'out', 'e2e')
mkdirSync(outDir, { recursive: true })
console.log('data folder:', dataDir)
const shot = async (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) })
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: [root],
  // No AI at all: this run is about the League Office, and must never call a real Claude.
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

await step('create from example', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
})
const slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])
await shot(page, 's01-office-preseason')

await step('start season', async () => {
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
  await shot(page, 's02-office-regular')
})

await step('record a game in the UI with a box score', async () => {
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.game-line')
  const line = page.locator('.game-line').first()
  await line.locator('input.score').nth(0).fill('101')
  await line.locator('input.score').nth(1).fill('99')
  await line.locator('button:has-text("박스스코어")').click()
  await page.locator('.box-editor input.stat').first().fill('30')
  await line.locator('button:has-text("기록")').click()
  await page.waitForTimeout(500)
  await shot(page, 's03-schedule')
})

await step('weekly awards: a 1주차 이주의 선수 in each conference, picked by week, never by code', async () => {
  // The example league gives 이주의 선수 per conference (its 북부 and 남부, as an NBA league's 동부 and 서부).
  const { config } = await invoke('leagues.snapshot', slug)
  const conferences = config.structure.conferences
  if (conferences.length !== 2 || config.awards.periodic.find((a) => a.id === 'potw')?.scope !== 'conference') throw new Error('the example league’s 이주의 선수 is not per conference')
  await page.click('.nav a:has-text("시상")')
  await page.waitForSelector('text=주간·월간 시상')
  const card = page.locator('.card:has(h3:text-is("이주의 선수"))')
  // Nothing given yet: the picker starts at the first week, and says it as one.
  const picker = card.locator('select[aria-label="이주의 선수: 주기"]')
  const picked = await picker.evaluate((s) => [s.value, s.selectedOptions[0]?.textContent])
  if (JSON.stringify(picked) !== JSON.stringify(['w1', '1주차'])) throw new Error(`the period picker starts at ${JSON.stringify(picked)}`)
  // One place per conference, each listing only its own schools' players.
  for (const c of conferences) {
    const slot = card.locator(`[role="group"][aria-label="1주차 ${c.name} 이주의 선수"]`)
    await slot.locator('select').selectOption({ index: 1 })
    await slot.locator('button:has-text("추가")').click()
    await slot.locator('.badge').waitFor()
  }
  const given = (await invoke('awards.list', slug)).filter((a) => a.awardId === 'potw' && a.period === 'w1')
  if (JSON.stringify(given.map((a) => a.group).sort()) !== JSON.stringify(conferences.map((c) => c.id).sort())) throw new Error(JSON.stringify(given))
  // Both places are filled: 1주차 offers no more players.
  if ((await card.locator('[role="group"][aria-label^="1주차 "] select').count()) > 0) throw new Error('a filled place still offers a player')
  if ((await card.textContent()).includes('w1')) throw new Error('the card shows a period code')
  await shot(page, 's03b-weekly-awards')
})

await step('trade, check the 2K block, veto', async () => {
  await page.click('.nav a:has-text("트레이드")')
  await page.waitForSelector('text=트레이드 만들기')
  const a = page.locator('.grid-2 .card').nth(0)
  const b = page.locator('.grid-2 .card').nth(1)
  await a.locator('label.check').first().click()
  await b.locator('label.check').first().click()
  await page.waitForSelector('text=규칙상 문제없어요.')
  await shot(page, 's04-trade-preview')
  await page.click('button:has-text("트레이드 기록")')
  await page.waitForSelector('text=2K 적용 대기')
  await shot(page, 's05-trade-history')
  await page.click('button:has-text("거부권 행사")')
  await page.waitForSelector('text=거부됨')
})

await step('trade again and apply in 2K via inbox', async () => {
  const a = page.locator('.grid-2 .card').nth(0)
  const b = page.locator('.grid-2 .card').nth(1)
  await a.locator('label.check').nth(1).click()
  await b.locator('label.check').nth(1).click()
  await page.waitForSelector('text=규칙상 문제없어요.')
  await page.click('button:has-text("트레이드 기록")')
  await page.waitForSelector('text=2K 적용 대기')
  await page.click('.nav a:has-text("인박스")')
  await page.waitForSelector('text=2K에 적용함')
  await shot(page, 's06-inbox')
  await page.click('button:has-text("2K에 적용함")')
  await page.waitForSelector('text=적용 완료')
})

await step('play out the regular season through the bridge', async () => {
  const games = await invoke('season.games', slug)
  for (const g of games.filter((x) => x.status === 'scheduled')) {
    const h = 80 + ((g.id * 7) % 30)
    const a = 80 + ((g.id * 11) % 29)
    await invoke('season.recordScore', slug, { gameId: g.id, homeScore: h === a ? h + 1 : h, awayScore: a, lines: null })
  }
  await page.click('.nav a:has-text("순위")')
  await page.waitForSelector('table.data')
  await shot(page, 's07-standings')
})

await step('start playoffs from the office', async () => {
  await page.click('.nav a:has-text("리그 사무국")')
  await page.click('button:has-text("플레이오프 시작")')
  await page.waitForSelector('text=대진표')
})

await step('play the playoffs', async () => {
  for (let i = 0; i < 60; i++) {
    const open = (await invoke('season.games', slug)).filter((g) => g.status === 'scheduled' && g.stage !== 'regular')
    if (open.length === 0) break
    for (const g of open) await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 100, awayScore: 90, lines: null })
  }
  await page.click('.nav a:has-text("플레이오프")')
  await page.waitForSelector('.series-card')
  await shot(page, 's08-playoffs')
  await page.click('.nav a:has-text("리그 사무국")')
  await page.click('button:has-text("플레이오프 마치기")')
  await page.waitForSelector('text=드래프트 룸으로')
})

await step('draft: protect, close, swap, finish', async () => {
  await page.click('a:has-text("드래프트 룸으로")')
  await page.waitForSelector('text=지명 순서')
  const prot = page.locator('.card:has(h2:text-is("보호"))')
  await prot.locator('select').nth(1).selectOption({ index: 1 })
  await prot.locator('button:has-text("보호")').first().click()
  await page.waitForTimeout(400)
  await shot(page, 's09-protection')
  await page.click('button:has-text("보호 마감하고 스왑 시작")')
  await page.waitForSelector('text=지금 차례')
  const turn = page.locator('.card:has(h2:has-text("지금 차례"))')
  await turn.locator('select').nth(0).selectOption({ index: 1 })
  await turn.locator('select').nth(1).selectOption({ index: 1 })
  await turn.locator('button:has-text("스왑")').click()
  await page.waitForTimeout(400)
  await shot(page, 's10-draft')
  await page.click('button:has-text("드래프트 마치기")')
  await page.waitForSelector('text=드래프트는 플레이오프가 끝난 뒤에 열려요')
})

await step('awards and export', async () => {
  await page.click('.nav a:has-text("시상")')
  await page.waitForSelector('text=시즌 시상')
  const first = page.locator('.award-slot').first()
  await first.locator('select').selectOption({ index: 1 })
  await first.locator('button:has-text("추가")').click()
  await page.waitForTimeout(300)
  await shot(page, 's11-awards')
  await page.click('.nav a:has-text("편집실")')
  await page.click('button:has-text("엑셀로 내보내기")')
  await page.waitForSelector('text=저장했어요')
})

await step('season 2: look back at season 1, read only, and export every season', async () => {
  const first = (await invoke('leagues.snapshot', slug)).season
  // The draft's swap is made in 2K first: the next season waits for it.
  for (const c of await invoke('checklist.list', slug)) if (!c.appliedAt) await invoke('checklist.apply', slug, c.id)
  await invoke('season.next', slug, '시즌 2')
  await invoke('season.start', slug)
  // An unknown season is refused, in Korean, by the server.
  const refused = await page.evaluate(async ([s]) => window.twok.invoke('season.standings', s, 999), [slug])
  if (refused.ok || refused.error?.rules?.[0]?.code !== 'unknown-season') throw new Error(JSON.stringify(refused))
  await page.click('.nav a:has-text("순위")')
  const picker = page.locator('select[aria-label="시즌"]')
  await picker.waitFor()
  await picker.selectOption(String(first.id))
  await page.waitForSelector(`text=지난 시즌(${first.label})을 보고 있어요`)
  if (!(await page.evaluate(() => location.hash.includes('season=')))) throw new Error('the pick is not in the URL')
  await shot(page, 's12-past-standings')
  // Past results are read only: no score entry or round tools.
  await page.click('.nav a:has-text("일정·결과")')
  await page.goto((await page.evaluate(() => location.href)).replace(/(#[^?]*)(\?.*)?$/, `$1?season=${first.id}`))
  await page.waitForSelector(`text=지난 시즌(${first.label})을 보고 있어요`)
  if ((await page.locator('button:has-text("기록")').count()) > 0) throw new Error('a past season offers to record a score')
  await page.click('button:has-text("지금 시즌으로")')
  await page.waitForSelector('text=지난 시즌', { state: 'detached' })
  await page.click('.nav a:has-text("편집실")')
  await page.click('[role="radiogroup"][aria-label="내보낼 시즌"] button:has-text("모든 시즌")')
  await page.click('button:has-text("엑셀로 내보내기")')
  await page.waitForSelector('text=저장했어요')
})

const problems = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
if (problems.length > 0) console.log(problems.join('\n'))
await app.close()
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
if (problems.length > 0) process.exit(1)
