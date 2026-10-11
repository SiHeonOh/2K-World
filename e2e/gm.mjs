// End-to-end: the AI GMs (단장실) on the made-up example league, with the
// demo GMs. Opens a trade window by hand, watches the negotiations land in
// the log (messages and 속마음), vetoes a GM trade, looks at each GM's plan,
// switches autonomy to "propose" in 편집실, and approves a deal waiting for
// you. Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-gm-'))
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
    await shot(`gm-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}
const until = async (what, fn, ms = 20000) => {
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

await step('open a trade window from 단장실; the GMs negotiate', async () => {
  await page.click('.nav a:has-text("단장실")')
  await page.waitForSelector('.warroom h1:has-text("단장실")')
  await page.waitForSelector('text=아직 트레이드 창이 열린 적이 없어요')
  await page.click('button:has-text("지금 트레이드 창 열기")')
  await page.waitForSelector('text=움직이기 시작했어요')
  await until('the window to close', async () => (await invoke('gm.status', slug)).open === null)
  await page.waitForSelector('.gm-talk .badge:has-text("성사")')
  await page.waitForSelector('.gm-step .gm-note:has-text("속마음")')
  await shot('gm01-log')
})

await step('traded players speak, and the locker room shows it', async () => {
  const deal = (await invoke('gm.windows', slug))[0].negotiations.find((n) => n.status === 'accepted')
  const team = deal.fromTeam
  await until('a traded player’s words', async () => (await invoke('mood.team', slug, team)).players.some((p) => p.said?.quote))
  await page.goto(page.url().replace(/#\/l\/.*$/, `#/l/${encodeURIComponent(slug)}/team/${encodeURIComponent(team)}`))
  await page.waitForSelector('.mood-said q')
  await shot('gm01b-locker-room-words')
  // His name opens his page: the mood line, the move, and what he said with his 속마음.
  await page.locator('.mood-row:has(.mood-said q) .mood-lore').first().click()
  await page.waitForSelector('.pstate-head h1')
  await page.waitForSelector('.pstate-chart svg circle')
  await page.waitForSelector('.pstate-timeline q')
  await page.waitForSelector('.pstate-timeline :text("트레이드:")')
  await page.waitForSelector('.pstate-timeline .mood-said-note')
  await shot('gm01c-player-page')
  await page.click('.nav a:has-text("단장실")')
  await page.waitForSelector('.warroom h1:has-text("단장실")')
})

await step('속마음 can be hidden', async () => {
  await page.click('label.check:has-text("속마음 보기")')
  if ((await page.locator('.gm-note').count()) !== 0) throw new Error('notes still shown')
  await page.click('label.check:has-text("속마음 보기")')
  await page.waitForSelector('.gm-note')
})

await step('a GM trade is on the 2K checklist and can be vetoed', async () => {
  const before = (await invoke('checklist.list', slug)).filter((c) => c.appliedAt === null).length
  if (before === 0) throw new Error('no GM trade on the checklist')
  await page.locator('.gm-talk.accepted button:has-text("거부권")').first().click()
  await page.waitForSelector('.gm-talk .badge:has-text("거부권 발동")')
  const after = (await invoke('checklist.list', slug)).filter((c) => c.appliedAt === null).length
  if (after !== before - 1) throw new Error(`checklist ${before} → ${after}`)
})

await step('each GM shows its plan', async () => {
  await page.click('.segmented button:has-text("단장들")')
  await page.waitForSelector('.gm-card .badge:has-text("보강")')
  await shot('gm02-gms')
})

await step('with autonomy set to propose, a deal waits for your approval', async () => {
  await page.click('.nav a:has-text("편집실")')
  await page.selectOption('.card:has(h2:has-text("단장 설정")) select >> nth=0', 'propose')
  await page.click('.card:has(h2:has-text("단장 설정")) button:has-text("저장")')
  await page.waitForSelector('.card:has(h2:has-text("단장 설정")) .notice:has-text("저장했어요")')
  await page.click('.nav a:has-text("단장실")')
  await page.click('button:has-text("지금 트레이드 창 열기")')
  await until('the window to close', async () => (await invoke('gm.status', slug)).open === null)
  await page.waitForSelector('h3:has-text("승인 대기")')
  const trades = (await invoke('trades.list', slug)).length
  await shot('gm03-approval')
  await page.locator('section:has(h3:has-text("승인 대기")) button:text-is("승인")').first().click()
  await page.waitForSelector('text=승인했어요')
  if ((await invoke('trades.list', slug)).length !== trades + 1) throw new Error('approved deal not recorded')
})

await step('편집실 → AI 모델: each job has its own model and effort', async () => {
  await page.click('.nav a:has-text("편집실")')
  await page.waitForSelector('.ai-models h2:has-text("AI 모델")')
  await page.selectOption('select[aria-label="위키 편집 모델"]', 'fable')
  await page.selectOption('select[aria-label="위키 편집 노력"]', 'max')
  await page.selectOption('select[aria-label="스크린샷 읽기 노력"]', 'high')
  await page.click('.ai-models button:has-text("저장")')
  await page.waitForSelector('.ai-models .notice:has-text("저장했어요")')
  const jobs = (await invoke('leagues.snapshot', slug)).config.ai.jobs
  if (jobs.wiki.model !== 'fable' || jobs.wiki.effort !== 'max' || jobs.screenshot.effort !== 'high' || jobs.reply.model !== 'haiku') throw new Error(JSON.stringify(jobs))
  await shot('gm03b-ai-models')
  // 최근 작업: the GM jobs that just ran, with their AI 모델 row and status (the demo writer reports no tokens).
  await page.waitForSelector('.ai-recent h2:has-text("최근 작업")')
  await page.waitForSelector('.ai-recent tbody tr:has-text("완료")')
  await page.click('.ai-recent button:has-text("새로고침")')
  await page.waitForSelector('.ai-recent tbody tr:has-text("단장")')
  await shot('gm03c-ai-recent')
})

await step('a whole season, fast (GM moves are made in 2K at once)', async () => {
  const cfg = (await invoke('leagues.snapshot', slug)).config.gm
  await invoke('gm.saveSettings', slug, { ...cfg, autonomy: 'full' })
  const applyAll = async () => {
    for (const c of await invoke('checklist.list', slug)) if (!c.appliedAt) await invoke('checklist.apply', slug, c.id)
  }
  await invoke('season.start', slug)
  for (let guard = 0; guard < 400; guard++) {
    const phase = (await invoke('leagues.snapshot', slug)).season.phase
    const games = (await invoke('season.games', slug)).filter((g) => g.status === 'scheduled')
    if (games.length === 0) {
      if (phase === 'regular') await invoke('season.startPlayoffs', slug)
      else if (phase === 'playoffs') await invoke('season.finishPlayoffs', slug)
      else break
      continue
    }
    for (const g of games) {
      // A GM trade can land at any moment (its window runs in the background): make it in 2K, then record.
      for (let tries = 0; ; tries++) {
        await applyAll()
        try {
          await invoke('season.recordScore', slug, { gameId: g.id, homeScore: 80 + (g.id % 7), awayScore: 75 + (g.id % 5), lines: null })
          break
        } catch (e) {
          if (tries > 5) throw e
          await page.waitForTimeout(300)
        }
      }
    }
  }
  if ((await invoke('leagues.snapshot', slug)).season.phase !== 'draft') throw new Error('not in the draft')
})

await step('the AI GMs protect, then pick in turn once protection is closed', async () => {
  await until('the protections', async () => {
    const s = await invoke('gm.status', slug)
    return s.draft && s.draft.working === 0 && (await invoke('draft.view', slug)).protectedPlayers.length > 0
  })
  await page.click('.nav a:has-text("카드·드래프트")')
  await page.waitForSelector('text=AI 단장들이 보호를 마쳤어요')
  await shot('gm04-draft-protected')
  await page.click('button:has-text("보호 마감하고 스왑 시작")')
  // The example league has one school you run: the AI stops at its turn until you move (here: pass).
  let waited = false
  await until(
    'every pick',
    async () => {
      const view = await invoke('draft.view', slug)
      if (view.next === null) return true
      const s = await invoke('gm.status', slug)
      if (s.draft?.waitingFor && s.draft.working === 0) {
        if (!waited) {
          await page.waitForSelector('text=직접 운영하는 학교')
          await shot('gm04b-draft-your-turn')
          waited = true
        }
        await invoke('draft.move', slug, { kind: 'pass', teamId: s.draft.waitingFor, cardId: view.next.id })
      }
      return false
    },
    90000,
  )
  if (!waited) throw new Error('never waited for the school you run')
  // The passes went over IPC, not through this screen: open it again to see the end.
  await page.click('.nav a:has-text("시상")')
  await page.click('.nav a:has-text("카드·드래프트")')
  await page.waitForSelector('text=모든 카드를 썼어요')
  await shot('gm05-draft-done')
  await page.click('.nav a:has-text("단장실")')
  await page.click('.segmented button:has-text("드래프트")')
  await page.waitForSelector('.gm-draft-note .badge:has-text("지명")')
  await page.waitForSelector('.gm-draft-note .gm-note')
  await shot('gm06-draft-notes')
})

await step('wiki editors write up the playoffs, the draft and an award', async () => {
  await page.click('.nav a:has-text("시상")')
  await page.waitForSelector('text=시즌 시상')
  const first = page.locator('.award-slot').first()
  await first.locator('select').selectOption({ index: 1 })
  await first.locator('button:has-text("추가")').click()
  const award = await until('the award', async () => (await invoke('awards.list', slug)).at(-1))
  const { DatabaseSync } = await import('node:sqlite')
  const leagues = join(dataDir, 'data')
  const folder = readdirSync(leagues).find((s) => existsSync(join(leagues, s, 'league.sqlite')))
  const db = new DatabaseSync(join(leagues, folder, 'league.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  let title
  try {
    // Each occasion's job runs and saves edits; the demo writer's numbers all come from its facts.
    const saved = (kind) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM wiki_revisions r JOIN jobs j ON j.id = r.job_id
           WHERE j.kind = 'wiki_edits' AND j.status = 'done' AND json_extract(j.input, '$.occasion.kind') = ?`,
        )
        .get(kind).n
    const busy = () => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'wiki_edits' AND status IN ('queued', 'running')").get().n
    await until('the occasion edits', async () => busy() === 0 && saved('award') > 0, 60000)
    for (const kind of ['playoffs', 'draft', 'award']) if (!saved(kind)) throw new Error(`no wiki edits after the ${kind}`)
    const marked = db.prepare('SELECT COUNT(*) AS n FROM ai_flags').get().n
    if (marked) throw new Error(`demo writing was marked ${marked} times`)
    title = db.prepare("SELECT title FROM wiki_pages WHERE kind = 'player' AND ref_id = ?").get(award.playerId).title
  } finally {
    db.close()
  }
  // The winner's page shows a fan editor's edit in 역사.
  await page.click('.nav a:has-text("위키")')
  await page.fill('.wk-search input', title)
  await page.click('.wk-search button')
  await page.waitForSelector(`.wk-head h1:has-text("${title}")`)
  await page.click('.wk-tools button:has-text("역사")')
  await page.waitForSelector('.wk-revs .wk-who.fan')
  await shot('gm06b-award-wiki')
})

await step('after a whole season, a player’s page draws his mood over it', async () => {
  const team = (await invoke('leagues.snapshot', slug)).teams[0].id
  await page.goto(page.url().replace(/#\/l\/.*$/, `#/l/${encodeURIComponent(slug)}/team/${encodeURIComponent(team)}`))
  await page.locator('.mood-row .mood-lore').first().click()
  await page.waitForSelector('.pstate-chart svg path.line')
  if ((await page.locator('.pstate-chart svg circle').count()) < 10) throw new Error('too few points for a whole season')
  // Lasting feelings: thin lines on the chart, and the card with trust, attachment and wanting out.
  await page.waitForSelector('.pstate-chart svg path.feeling-line.attachment[d^="M"]')
  await page.waitForSelector('.pstate-feeling-head:has-text("단장 신뢰")')
  await page.waitForSelector('.pstate-feeling-head:has-text("학교 애착")')
  await page.waitForSelector('.pstate-parts :text("소속감")')
  await shot('gm07-player-season')
})

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) {
  console.log('page errors:\n' + errors.join('\n'))
  await app.close()
  process.exit(1)
}
await app.close()
console.log('gm e2e passed')
