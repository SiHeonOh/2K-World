// End-to-end: the wiki on the made-up example league. Opens the league page,
// follows a link to a school (live infobox and roster), edits a page with a
// new red link, checks history and 비교, reverts, finds it in 최근 변경 and
// search, creates the missing page, opens a 토론 that the (demo) editors
// answer, closes and reopens it, and sets edit wars in 편집실. Run
// `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-wk-'))
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
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    console.log('FAIL', name, String(e).slice(0, 400))
    await shot(`wk-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}

await step('create a league and open the wiki', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  await page.click('button:has-text("시즌 시작")')
  await page.waitForSelector('text=경기 결과 입력')
  await page.click('.nav a:has-text("위키")')
  await page.waitForSelector('.wk-head h1')
  await page.waitForSelector('.wk-toc')
  await shot('wk01-league')
})

let school = ''
await step('a school page has a live infobox and roster', async () => {
  const link = page.locator('.wk-body .wk-link').first()
  school = (await link.innerText()).trim()
  await link.click()
  await page.waitForSelector(`.wk-head h1:has-text("${school}")`)
  await page.waitForSelector('.wk-infobox')
  await page.waitForSelector('.wk-table td')
  await shot('wk02-school')
})

await step('edit with a new link: it shows red, history has r2', async () => {
  await page.click('.wk-tools button:has-text("편집")')
  await page.waitForSelector('.wk-editor')
  const source = await page.inputValue('.wk-editor')
  await page.fill('.wk-editor', `${source}\n== 응원가 ==\n[[응원가 모음]]에 정리되어 있다.`)
  await page.fill('.wk-save input', '응원가 추가')
  await page.click('.wk-save button:has-text("저장")')
  await page.waitForSelector('.wk-link.missing:has-text("응원가 모음")')
  await page.click('.wk-tools button:has-text("역사")')
  await page.waitForSelector('.wk-revs td:has-text("응원가 추가")')
  await shot('wk03-history')
})

await step('비교: r1 → r2 shows the new lines as added, and steps back to history', async () => {
  await page.click('.wk-revs tr:has-text("응원가 추가") button:has-text("비교")')
  await page.waitForSelector('.wk-diff tr.add:has-text("응원가 모음")')
  await page.waitForSelector('.wk-diff-meta:has-text("r1")')
  await shot('wk03b-diff')
  await page.click('.wk-tools button:has-text("역사")')
  await page.waitForSelector('.wk-revs td:has-text("응원가 추가")')
})

await step('revert to r1, then find the edits in 최근 변경 and search', async () => {
  await page.click('.wk-revs button:has-text("되돌리기")')
  await page.waitForSelector('.wk-revs td:has-text("r1(으)로 되돌림")')
  await page.click('.wk-nav button:has-text("최근 변경")')
  await page.waitForSelector('.wk-revs td:has-text("응원가 추가")')
  await page.fill('.wk-search input', school)
  await page.click('.wk-search button')
  await page.waitForSelector(`.wk-head h1:has-text("${school}")`)
})

await step('a missing page can be created', async () => {
  await page.fill('.wk-search input', '응원가 모음')
  await page.click('.wk-search button')
  await page.waitForSelector('.wk-head h1:has-text("검색 결과")')
  await page.click('.wk-link.missing:has-text("응원가 모음")')
  await page.waitForSelector('text=새 문서 만들기')
  await page.click('button:has-text("새 문서 만들기")')
  await page.fill('.wk-editor', '== 개요 ==\n응원가를 모은 문서.')
  await page.click('.wk-save button:has-text("저장")')
  await page.waitForSelector('.wk-head h1:has-text("응원가 모음")')
  await page.waitForSelector('.wk-h:has-text("개요")')
  await shot('wk04-new-page')
})

await step('토론: open a thread, the editors answer, reply, close and reopen it', async () => {
  await page.fill('.wk-search input', school)
  await page.click('.wk-search button')
  await page.waitForSelector(`.wk-head h1:has-text("${school}")`)
  await page.click('.wk-tools button:has-text("토론")')
  await page.waitForSelector('text=아직 이 문서에 토론이 없어요.')
  await page.fill('.wk-newthread input', '개요 서술 관련')
  await page.fill('.wk-newthread textarea', '개요가 너무 짧습니다.')
  await page.click('.wk-newthread button:has-text("토론 열기")')
  await page.waitForSelector('.wk-res.user:has-text("개요가 너무 짧습니다.")')
  // The demo editors' answers arrive by themselves.
  await page.waitForSelector('.wk-res.fan', { timeout: 30_000 })
  await page.fill('.wk-reply textarea', '근거는 기록 표에 있습니다.')
  await page.click('.wk-reply button:has-text("댓글 달기")')
  await page.waitForSelector('.wk-res.user:has-text("근거는 기록 표에 있습니다.")')
  await shot('wk05-talk')
  await page.fill('.wk-reply input', '해결됨')
  await page.click('.wk-reply button:has-text("토론 닫기")')
  await page.waitForSelector('text=닫힌 토론이에요: 해결됨')
  await page.click('button:has-text("다시 열기")')
  await page.waitForSelector('.wk-reply textarea')
  await page.click('.wk-nav button:has-text("최근 토론")')
  await page.waitForSelector('.wk-revs td:has-text("개요 서술 관련")')
  // The page's 토론 tab counts the open thread.
  await page.click('.wk-revs td a:has-text("' + school + '")')
  await page.waitForSelector('.wk-tools button:has-text("토론 (1)")')
})

await step('a revision with a number its facts didn’t hold shows a notice and a badge in 역사', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const leagues = join(dataDir, 'data')
  const folder = readdirSync(leagues).find((s) => existsSync(join(leagues, s, 'league.sqlite')))
  const db = new DatabaseSync(join(leagues, folder, 'league.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    const marked = db.prepare('SELECT COUNT(*) AS n FROM ai_flags').get().n
    if (marked) throw new Error(`demo writing was marked ${marked} times`)
    // The school page's newest revision, as if an AI editor had written a number its facts didn't hold.
    const rev = db
      .prepare('SELECT r.id FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id WHERE p.title = ? ORDER BY r.rev DESC LIMIT 1')
      .get(school)
    db.prepare("INSERT INTO ai_flags (target_kind, target_id, numbers, job_id, created_at) VALUES ('wiki_revision', ?, '[\"41\"]', NULL, ?)").run(
      rev.id,
      new Date().toISOString(),
    )
  } finally {
    db.close()
  }
  // Away and back, so the page loads again (it's already open).
  await page.click('.wk-nav button:has-text("최근 변경")')
  await page.waitForSelector('.wk-head h1:has-text("최근 변경")')
  await page.fill('.wk-search input', school)
  await page.click('.wk-search button')
  await page.waitForSelector(`.wk-head h1:has-text("${school}")`)
  await page.waitForSelector('.wk-flagged-note:has-text("41")')
  await page.click('.wk-tools button:has-text("역사")')
  await page.waitForSelector('.wk-revs .wk-flagged')
  if ((await page.locator('.wk-revs .wk-flagged').count()) !== 1) throw new Error('more than one revision has the badge')
  if ((await page.locator('.wk-revs tbody tr').first().locator('.wk-flagged').count()) !== 1) throw new Error('the badge is not on the newest revision')
  await shot('wk05b-number-mark')
})

await step('편집실 → 위키: edit wars set to 자주', async () => {
  await page.click('.nav a:has-text("편집실")')
  await page.click('[role="radiogroup"][aria-label="편집 분쟁"] button:has-text("자주")')
  await page.click('.card:has(h2:has-text("위키")) button:has-text("저장")')
  await page.waitForSelector('.card:has(h2:has-text("위키")) .notice:has-text("저장했어요")')
  await shot('wk06-settings')
})

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) {
  console.log('page errors:\n' + errors.join('\n'))
  await app.close()
  process.exit(1)
}
await app.close()
console.log('wiki e2e passed')
