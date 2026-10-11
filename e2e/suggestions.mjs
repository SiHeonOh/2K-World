// End-to-end: the lore suggestion inbox (제안함) on the made-up example league,
// with the demo writer. Asks for AI drafts of one school's blank files, checks
// nothing reaches a file before approval, approves one as it is, edits and
// approves another, turns one down, approves the rest at once, asks for one
// file's draft with a description, lets a finished round bring
// suggestions (nicknames set to approve themselves), and turns a secret the
// news gave away into a 비밀 공개 card that moves it only once approved.
// Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-suggest-'))
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
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    console.log('FAIL', name, String(e).slice(0, 600))
    await shot(`sg-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}
const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(250)
  }
}

await step('create a league', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
})
const slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])
const loreDir = join(dataDir, 'data', slug, 'lore')
const snap = await invoke('leagues.snapshot', slug)
const team = snap.teams[0]
const roster = snap.players.filter((p) => p.teamId === team.id)
const fileOf = (p) => join(loreDir, 'teams', team.shortName, `${p.name}.md`)

await step('ask for AI drafts of one school; nothing is written yet', async () => {
  await page.click('.nav a:has-text("로어")')
  await page.waitForSelector('.lore-overview h1:has-text("로어")')
  await page.selectOption('select[aria-label="AI 초안"]', team.id)
  await page.click('.card:has(h3:has-text("AI 초안")) button:has-text("초안 받기")')
  await page.waitForSelector('text=파일 8개의 초안을 쓰는 중이에요')
  await shot('sg01-draft-card')
  await until('drafts', async () => (await invoke('suggestions.status', slug)).pending === 8)
  if (existsSync(fileOf(roster[0]))) throw new Error('a draft reached a file before approval')
})

await step('the inbox lists the drafts, with a badge in the nav', async () => {
  await page.click('.nav a:has-text("인박스")')
  await page.waitForSelector('.nav a:has-text("인박스") .nav-badge:has-text("8")')
  await page.waitForSelector('.segmented button.on:has-text("제안함 8")')
  await page.waitForSelector(`.suggest-group-head h3:has-text("AI 초안 · ${team.shortName}")`)
  await shot('sg02-inbox')
})

await step('approve a draft as it is: the file is made with it', async () => {
  const card = page.locator(`.suggest-card:has(.suggest-name:text-is("${roster[0].name}"))`)
  const text = await card.locator('.suggest-new-text').first().innerText()
  await card.locator('button:text-is("승인")').click()
  await page.waitForSelector(`text=teams/${team.shortName}/${roster[0].name}.md에 넣었어요.`)
  const file = readFileSync(fileOf(roster[0]), 'utf8')
  if (!file.includes(text)) throw new Error(`draft text not in the file:\n${file}`)
})

await step('edit a draft, then approve it', async () => {
  const card = page.locator(`.suggest-card:has(.suggest-name:text-is("${roster[1].name}"))`)
  await card.locator('button:has-text("고쳐서 승인")').click()
  await card.locator('textarea[aria-label="공개"]').fill('내가 고친 이야기. 왼손잡이 슈터다.')
  await card.locator('[role="radiogroup"][aria-label="자존심"] button:text-is("5")').click()
  await shot('sg03-editing')
  await card.locator('button:has-text("이대로 승인")').click()
  await page.waitForSelector(`text=teams/${team.shortName}/${roster[1].name}.md에 넣었어요.`)
  const file = readFileSync(fileOf(roster[1]), 'utf8')
  if (!file.includes('내가 고친 이야기. 왼손잡이 슈터다.')) throw new Error('edited text not saved')
  if (!/ego: 5/.test(file)) throw new Error('edited trait not saved')
})

await step('turn down the GM draft, approve the rest at once', async () => {
  const gm = page.locator(`.suggest-card:has(.suggest-name:text-is("${team.shortName} 단장"))`)
  await gm.locator('button:text-is("거절")').click()
  await page.waitForSelector(`.suggest-card:has(.suggest-name:text-is("${team.shortName} 단장"))`, { state: 'detached' })
  await page.click('.suggest-group-head button:has-text("5개 모두 승인")')
  await page.waitForSelector('text=5개 승인')
  await page.waitForSelector('text=기다리는 제안이 없어요')
  if (existsSync(join(loreDir, 'teams', team.shortName, `${team.shortName} 단장.md`))) throw new Error('rejected GM draft was written')
  await page.click('button:has-text("처리한 제안")')
  await page.waitForSelector('.suggest-history-table td:has-text("거절")')
  await shot('sg04-history')
})

await step('ask for one file’s draft with your own description', async () => {
  await page.click('.nav a:has-text("로어")')
  await page.click(`.lore-item.player:has(.lore-item-label:text-is("${roster[2].name}"))`)
  await page.waitForSelector(`.lore-editor-title h2:has-text("${roster[2].name}")`)
  await page.click('.lore-editor-tools button:has-text("AI 초안")')
  await page.fill('textarea[aria-label="AI 초안 받기"]', '말수는 적지만 4쿼터의 사나이')
  await page.click('button:has-text("초안 요청")')
  await page.waitForSelector('text=초안을 쓰는 중이에요')
  await until('one draft', async () => (await invoke('suggestions.status', slug)).pending === 1)
  await page.click('.lore-editor-tools a:has-text("제안함으로")')
  await page.waitForSelector('.suggest-card p.help:has-text("말수는 적지만 4쿼터의 사나이")')
  await shot('sg05-one-draft')
})

await step('set nicknames to approve themselves in 편집실', async () => {
  await page.click('.nav a:has-text("편집실")')
  await page.click('[role="radiogroup"][aria-label="별명"] button:has-text("바로 넣기")')
  await page.click('.card:has(h2:has-text("로어 제안")) button:has-text("저장")')
  await page.waitForSelector('.card:has(h2:has-text("로어 제안")) .notice:has-text("저장했어요")')
  const cfg = (await invoke('leagues.snapshot', slug)).config.lore
  if (cfg.suggest.nickname !== 'auto') throw new Error('mode not saved')
})

await step('a finished round brings suggestions; the nickname goes straight onto the roster', async () => {
  await invoke('season.start', slug)
  const games = (await invoke('season.games', slug)).filter((g) => g.stage === 'regular' && g.round === 1)
  for (const g of games) {
    const lines = snap.players.filter((p) => p.teamId === g.home || p.teamId === g.away).map((p, i) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 30 - i } }))
    await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
  }
  const nick = await until('auto nickname', async () => (await invoke('leagues.snapshot', slug)).players.find((p) => p.nicknames.includes('R1의 사나이')))
  await page.click('.nav a:has-text("인박스")')
  await page.click('.segmented button:has-text("제안함")')
  await page.waitForSelector('.suggest-group-head h3:has-text("R1 이후")')
  await page.click('button:has-text("처리한 제안")')
  await page.waitForSelector(`.suggest-history-table tr:has-text("${nick.name}"):has-text("자동")`)
  await shot('sg06-round')
})

await step('a secret the news gave away waits as a 비밀 공개 card, and moves to 소문 only when approved', async () => {
  // A player of the last school, whose file nobody drafted: his secret is written straight into the folder.
  const team = snap.teams.at(-1)
  const player = snap.players.find((p) => p.teamId === team.id)
  const dir = join(dataDir, 'data', slug, 'lore', 'teams', team.shortName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${player.name}.md`)
  writeFileSync(file, `---\nid: ${player.name}\n---\n\n## 공개\n\n## 소문\n\n## 비밀\n사실은 전학을 원한다\n`)
  // A file written from outside the app shows up within the lore re-read interval (5 s).
  await page.waitForTimeout(5500)
  await invoke('community.news', slug, { text: `${player.name}, 기자회견에서 사실은 전학을 원한다고 직접 밝혔다` })
  for (const g of (await invoke('season.games', slug)).filter((x) => x.stage === 'regular' && x.round === 2)) {
    await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 80, awayScore: 70, lines: null })
  }
  await until('a reveal card', async () => (await invoke('suggestions.list', slug, 'pending')).some((s) => s.kind === 'reveal'), 30000)
  // Leave the inbox and come back, so 제안함 loads afresh.
  await page.click('.nav a:has-text("리그 사무국")')
  await page.click('.nav a:has-text("인박스")')
  await page.click('.segmented button:has-text("제안함")')
  const card = page.locator('.suggest-card.reveal').first()
  await card.waitFor()
  await page.waitForSelector('.suggest-group-head h3:has-text("드러난 것 같은 비밀")')
  // Nothing has moved yet.
  if (!readFileSync(file, 'utf8').includes('## 비밀\n사실은 전학을 원한다')) throw new Error('the secret moved before approval')
  await shot('sg07-reveal-card')
  await card.locator('button:has-text("고쳐서 승인")').click()
  await card.locator('[role="radiogroup"] button:has-text("비밀 → 소문")').click()
  await card.locator('button:has-text("이대로 승인")').click()
  await until('the secret in 소문', async () => /## 소문\s*\n[^#]*전학을 원한다/.test(readFileSync(file, 'utf8')))
  if (/## 비밀\s*\n[^#]*전학/.test(readFileSync(file, 'utf8'))) throw new Error('the secret is still in 비밀')
})

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) {
  console.log('page errors:\n' + errors.join('\n'))
  await app.close()
  process.exit(1)
}
await app.close()
console.log('suggestions e2e passed')
