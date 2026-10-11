// End-to-end: game day with the demo reader (TWOK_FAKE_AI=1). Creates the
// made-up example league, starts the season, attaches two screenshots (the
// same one twice is refused), lets the reader "read" them, leaves and comes
// back to the same reading, swaps sides without losing edits, fixes any
// unmatched rows on the confirm screen, ticks the guessed names (saving
// waits for them) and records the game. Unread
// screenshots are deleted from the inbox. Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-gd-'))
const outDir = join(root, 'out', 'e2e')
mkdirSync(outDir, { recursive: true })
// A 1×1 PNG stands in for a screenshot; the demo reader doesn't look at it.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
// Two different files (bytes after IEND don't change the picture), plus a copy of the first.
const shots = [join(dataDir, 'home.png'), join(dataDir, 'away.png')]
writeFileSync(shots[0], png)
writeFileSync(shots[1], Buffer.concat([png, Buffer.from('away')]))
const copy = join(dataDir, 'home-copy.png')
writeFileSync(copy, png)
/** Screenshots waiting in the league's inbox. */
const inbox = () => {
  const leagues = join(dataDir, 'data')
  return readdirSync(leagues).flatMap((slug) => {
    const dir = join(leagues, slug, 'screenshots', 'inbox')
    return existsSync(dir) ? readdirSync(dir) : []
  })
}
const until = async (what, fn) => {
  for (let i = 0; i < 50; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out: ${what}`)
}

// A screenshot folder set in the app settings (as if chosen in 앱 설정), with two fresh shots.
const shotFolder = join(dataDir, 'steam-screenshots')
mkdirSync(shotFolder, { recursive: true })
mkdirSync(join(dataDir, 'data'), { recursive: true })
writeFileSync(
  join(dataDir, 'data', 'settings.json'),
  JSON.stringify({ version: 1, lastLeague: null, importMappings: [], screenshotFolder: shotFolder }),
)
writeFileSync(join(shotFolder, '20261010_1.png'), Buffer.concat([png, Buffer.from('folder-1')]))
writeFileSync(join(shotFolder, '20261010_2.png'), Buffer.concat([png, Buffer.from('folder-2')]))

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
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    console.log('FAIL', name, String(e).slice(0, 400))
    await shot(`gd-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}

await step('create and start', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
})

await step('the same screenshot twice is refused; removed ones leave the inbox', async () => {
  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('text=데모 모드')
  await page.setInputFiles('input[type=file]', [shots[0], copy])
  await page.waitForSelector('.shots img >> nth=1')
  await page.click('button:has-text("읽기 시작")')
  await page.waitForSelector('text=같은 스크린샷이 두 번')
  await page.click('.shots figure >> nth=1 >> button:has-text("빼기")')
  await page.waitForSelector('.shots img >> nth=1', { state: 'detached' })
  await until('one screenshot left in the inbox', () => inbox().length === 1)
})

await step('attach screenshots and read', async () => {
  await page.setInputFiles('input[type=file]', [shots[1]])
  await page.waitForSelector('.shots img >> nth=1')
  await shot('gd-01-shots')
  await page.click('button:has-text("읽기 시작")')
  await page.waitForSelector('text=읽은 내용을 확인하세요', { timeout: 20000 })
  await until('the read screenshots left the inbox', () => inbox().length === 0)
  await shot('gd-02-confirm')
})

await step('leaving and coming back picks the reading up again', async () => {
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.game-line')
  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('text=읽은 내용을 확인하세요', { timeout: 10000 })
})

await step('swapping sides keeps edited numbers', async () => {
  const firstStat = () => page.locator('.card.flush').first().locator('tbody input.stat').first()
  await firstStat().fill('77')
  const before = await page.locator('.card.flush h3').first().innerText()
  await page.click('button:has-text("홈/원정 바꾸기")')
  await page.waitForFunction((t) => document.querySelector('.card.flush h3')?.textContent !== t, before)
  // The edited row moved to the other table with its number.
  if ((await page.locator('.card.flush').nth(1).locator('tbody input.stat').first().inputValue()) !== '77') throw new Error('edit lost on swap')
  await page.click('button:has-text("홈/원정 바꾸기")')
  await page.waitForFunction((t) => document.querySelector('.card.flush h3')?.textContent === t, before)
  if ((await firstStat().inputValue()) !== '77') throw new Error('edit lost on swap back')
})

await step('fill open rows and record', async () => {
  for (const table of await page.locator('.card.flush').all()) {
    const selects = await table.locator('tbody select').all()
    const used = new Set(await Promise.all(selects.map((s) => s.inputValue())))
    for (const s of selects) {
      if ((await s.inputValue()) !== '') continue
      const values = await s.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
      const free = values.find((v) => !used.has(v))
      if (free) {
        await s.selectOption(free)
        used.add(free)
      }
    }
  }
  const save = page.locator('button:has-text("경기 기록")')
  // The demo reader's Korean names are guessed (romanized): each is saved only once ticked 맞아요.
  const guessed = await page.locator('.card.flush tbody label.name-ok input[type=checkbox]').all()
  if (guessed.length > 0 && (await save.isEnabled())) throw new Error('saving should wait until the guessed names are ticked')
  for (const box of guessed) await box.check()
  if (!(await save.isEnabled())) {
    // A tie: nudge one home player's points so the game has a winner.
    const first = page.locator('.card.flush').first().locator('tbody input.stat').first()
    await first.fill(String(Number(await first.inputValue()) + 1))
  }
  await save.click()
  await page.waitForSelector('text=기록했어요', { timeout: 10000 })
  await shot('gd-03-saved')
})

await step('the game shows as recorded with a box score', async () => {
  await page.click('.nav a:has-text("일정·결과")')
  await page.waitForSelector('.game-line')
  await page.waitForSelector('.game-line .badge:has-text("박스스코어")')
})

await step('screenshots left unread are deleted when leaving game day', async () => {
  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('.dropzone')
  await page.setInputFiles('input[type=file]', [shots[0]])
  await page.waitForSelector('.shots img')
  await until('one screenshot in the inbox', () => inbox().length === 1)
  await page.click('.nav a:has-text("일정·결과")')
  await until('the inbox is empty', () => inbox().length === 0)
})

await step('a failed reading comes back, and retries over the same screenshots', async () => {
  // A reading that failed earlier (say, before a restart), left in the league's job table.
  const { DatabaseSync } = await import('node:sqlite')
  const leagues = join(dataDir, 'data')
  const slug = readdirSync(leagues).find((s) => existsSync(join(leagues, s, 'league.sqlite')))
  const db = new DatabaseSync(join(leagues, slug, 'league.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  const game = db
    .prepare("SELECT id FROM games WHERE status = 'scheduled' ORDER BY stage = 'regular' DESC, round, id LIMIT 1 OFFSET 1")
    .get()
  const folder = join(leagues, slug, 'screenshots', `game-${game.id}-1`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, '1.png'), png)
  writeFileSync(join(folder, '2.png'), Buffer.concat([png, Buffer.from('2')]))
  const line = (name) => ({ name, pts: 2, reb: 1, ast: 0, stl: 0, blk: 0, to: 0, fgm: 1, fga: 2, tpm: 0, tpa: 0, ftm: 0, fta: 0 })
  const read = { teams: [{ team: 'A', players: [line('Q. One')] }, { team: 'B', players: [line('Q. Two')] }], notes: '' }
  writeFileSync(join(folder, 'fake-output.json'), JSON.stringify(read))
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO jobs (kind, status, priority, input, folder, error, error_kind, attempts, created_at, finished_at)
     VALUES ('read_box_score', 'failed', 50, ?, ?, 'demo failure', 'failed', 2, ?, ?)`,
  ).run(JSON.stringify({ images: ['1.png', '2.png'], teams: ['A', 'B'], gameId: game.id }), folder, now, now)
  db.close()

  await page.click('.nav a:has-text("경기일")')
  await page.waitForSelector('.dropzone')
  await page.selectOption('select[aria-label="기록할 경기 선택"]', String(game.id))
  await page.waitForSelector('text=읽지 못했어요')
  await page.waitForSelector('text=이어서 보여줘요')
  await shot('gd-04-failed')
  await page.click('button:has-text("같은 스크린샷으로 다시 읽기")')
  await page.waitForSelector('text=읽은 내용을 확인하세요', { timeout: 20000 })
  await page.click('button:has-text("새 스크린샷으로")')
  await page.waitForSelector('.dropzone')
})

await step('the newest shots come from the screenshot folder in one click', async () => {
  await page.click('button:has-text("스크린샷 폴더에서 최근 2장 가져오기")')
  await page.waitForSelector('.shots figure >> nth=1')
  for (let i = 0; i < 2; i++) await page.click('.shots figure button >> nth=0')
})

const problems = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
if (problems.length > 0) console.log(problems.join('\n'))
await app.close()
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
if (problems.length > 0) process.exit(1)
