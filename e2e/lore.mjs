// End-to-end: the lore editor on the made-up example league. Makes every
// missing file in one click, writes a player's story, traits, a relationship
// and a mood rule through the forms, checks the file on disk keeps the
// template's comments, merges an edit made in another editor, keeps unsaved
// edits across screens, restores an earlier version, and starts a world topic.
// Run `npm run build` first.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), '2kw-e2e-lore-'))
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
    await shot(`lo-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`)
    console.log(logs.join('\n'))
    await app.close()
    process.exit(1)
  }
}

await step('create a league and make every missing lore file', async () => {
  await page.click('text=새 리그 만들기 >> nth=0')
  await page.click('button.choice:has-text("샘플 리그")')
  await page.waitForSelector('text=리그 이름')
  await page.click('.stepper button:has-text("확인")')
  await page.click('button:has-text("리그 만들기")')
  await page.waitForSelector('text=에이스')
  await page.click('.nav a:has-text("로어")')
  await page.waitForSelector('.lore-overview h1:has-text("로어")')
  await page.click('.lore-overview .card button:has-text("빈 파일")')
  await page.waitForSelector('text=만들었어요')
  await page.waitForSelector('.lore-item.player:not(.missing)')
  await shot('lo01-overview')
})
const slug = decodeURIComponent(page.url().split('#/l/')[1].split('/')[0])
const loreDir = join(dataDir, 'data', slug, 'lore')
const snap = await invoke('leagues.snapshot', slug)
const team = snap.teams[0]
const roster = snap.players.filter((p) => p.teamId === team.id)
const player = roster[0]
const mate = snap.players.filter((p) => p.teamId !== team.id)[0]
const fileOf = (p) => join(loreDir, 'teams', snap.teams.find((t) => t.id === p.teamId).shortName, `${p.name}.md`)

await step('write a player’s story and save with Ctrl+S', async () => {
  await page.click(`.lore-item.player:has(.lore-item-label:text-is("${player.name}"))`)
  await page.waitForSelector(`.lore-editor-title h2:has-text("${player.name}")`)
  await page.fill('textarea[aria-label="공개"]', '가람고의 3점 슈터.\n별명은 "저격수".')
  await page.fill('textarea[aria-label="비밀"]', '사실 전학을 고민 중이다.')
  await page.waitForSelector('.lore-status.dirty')
  await shot('lo02-story')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(fileOf(player), 'utf8')
  if (!text.includes('가람고의 3점 슈터.\n별명은 "저격수".')) throw new Error('공개 not on disk')
  if (!text.includes('<!-- 본인만 아는 이야기')) throw new Error('hint comment lost')
  if (!text.includes('# 자존심, 대우받고 싶은 마음')) throw new Error('settings comments lost')
})

await step('set traits and the interview style', async () => {
  await page.click('.lore-tabs button:has-text("성격")')
  await page.click('[role="radiogroup"][aria-label="자존심"] button:text-is("5")')
  await page.click('[role="radiogroup"][aria-label="볼 욕심"] button:text-is("4")')
  await page.click('[role="radiogroup"][aria-label="인터뷰 스타일"] button:has-text("거침없음")')
  await shot('lo03-traits')
  await page.click('.lore-editor-actions button:has-text("저장")')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(fileOf(player), 'utf8')
  if (!/\n {2}ego: 5 +# 자존심/.test(text)) throw new Error(`ego not saved in place:\n${text}`)
  if (!/\nmedia: outspoken +#/.test(text)) throw new Error('media not saved in place')
})

await step('add a rival from another school by searching', async () => {
  await page.click('.lore-tabs button:has-text("관계")')
  await page.click('button:has-text("관계 추가")')
  await page.fill('input[aria-label="상대"]', mate.name)
  await page.click(`.lore-picker-list li:has-text("${mate.name}")`)
  await page.selectOption('select[aria-label="관계"]', 'rival')
  await page.click('[role="radiogroup"][aria-label="강도"] button:text-is("5")')
  await page.waitForSelector('.lore-picker-status.ok')
  await shot('lo04-relationships')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(fileOf(player), 'utf8')
  if (!text.includes(`  - with: ${mate.name}\n    type: rival\n    strength: 5`)) throw new Error(`relationship not saved:\n${text}`)
})

await step('add a mood rule for the rival’s awards', async () => {
  await page.click('.lore-tabs button:has-text("기분 규칙")')
  await page.click('button:has-text("규칙 추가")')
  await page.selectOption('select[aria-label="이럴 때"]', 'rival_award')
  await page.fill('input[aria-label="어느 라이벌"]', mate.name)
  await page.click(`.lore-picker-list li:has-text("${mate.name}")`)
  await shot('lo05-hooks')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(fileOf(player), 'utf8')
  if (!text.includes(`  - when: rival_award\n    mood: { stability: -20 }\n    rival: ${mate.name}`) && !text.includes('when: rival_award')) {
    throw new Error(`hook not saved:\n${text}`)
  }
})

await step('an edit made elsewhere is merged; the same field changed on both sides asks first', async () => {
  await page.click('.lore-tabs button:has-text("이야기")')
  // Another editor adds a rumor while the app is open.
  writeFileSync(fileOf(player), readFileSync(fileOf(player), 'utf8').replace('## 소문\n', '## 소문\n밖에서 쓴 소문.\n'))
  await page.fill('textarea[aria-label="공개"]', '가람고의 3점 슈터. 수비도 좋다.')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=다른 곳에서 바뀐 내용과 합쳐서 저장했어요')
  if ((await page.inputValue('textarea[aria-label="소문"]')) !== '밖에서 쓴 소문.') throw new Error('merged rumor not shown')

  writeFileSync(fileOf(player), readFileSync(fileOf(player), 'utf8').replace('밖에서 쓴 소문.', '밖에서 또 고친 소문.'))
  await page.fill('textarea[aria-label="소문"]', '내가 쓴 소문.')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=같은 부분이 다른 곳에서도 바뀌었어요')
  await shot('lo06-conflict')
  await page.click('button:has-text("내 변경으로 덮어쓰기")')
  await page.waitForSelector('text=저장했어요')
  if (!readFileSync(fileOf(player), 'utf8').includes('내가 쓴 소문.')) throw new Error('my rumor not saved')
})

await step('unsaved edits survive leaving the screen', async () => {
  await page.fill('textarea[aria-label="공개"]', '아직 저장 안 한 글.')
  await page.click('.nav a:has-text("순위")')
  await page.waitForSelector('h1')
  await page.click('.nav a:has-text("로어")')
  await page.waitForSelector('.lore-list')
  await page.waitForSelector('.lore-item .lore-unsaved')
  await page.click(`.lore-item.player:has(.lore-item-label:text-is("${player.name}"))`)
  await page.waitForSelector('text=저장하지 않은 변경을 이어서 편집하고 있어요')
  if ((await page.inputValue('textarea[aria-label="공개"]')) !== '아직 저장 안 한 글.') throw new Error('draft lost')
  await page.click('.lore-editor-actions button:has-text("되돌리기")')
  await page.waitForSelector('.lore-status:not(.dirty)')
})

await step('restore an earlier version from the history', async () => {
  await page.click('.lore-editor-meta button:has-text("이전 버전")')
  await page.waitForSelector('.lore-history-list li')
  await page.click('.lore-history-list li:last-child button')
  await page.waitForSelector('.lore-history-preview pre')
  await shot('lo07-history')
  await page.click('button:has-text("이 버전으로 되돌리기")')
  await page.waitForSelector('text=저장했어요')
  if (readFileSync(fileOf(player), 'utf8').includes('가람고의 3점 슈터')) throw new Error('not restored to the first version')
})

await step('a school page opens its lore; set colours, fans and a rival school', async () => {
  const rival = snap.teams[1]
  await page.evaluate(([s, id]) => void (location.hash = `#/l/${encodeURIComponent(s)}/team/${id}`), [slug, team.id])
  await page.click('a:has-text("학교 로어")')
  await page.waitForSelector(`.lore-editor-title h2:has-text("${team.shortName}")`)
  await page.click('.lore-tabs button:has-text("학교")')
  await page.fill('.lore-color input[type="text"] >> nth=0', '#e8590c')
  await page.click('[role="radiogroup"][aria-label="팬층 크기"] button:text-is("5")')
  await page.fill('input[aria-label="라이벌 학교"]', rival.shortName)
  await page.click(`.lore-picker-list li:has-text("${rival.shortName}")`)
  await page.waitForSelector(`.lore-chip:has-text("${rival.shortName}")`)
  await shot('lo08-team')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(join(loreDir, 'teams', team.shortName, `${team.shortName}.md`), 'utf8')
  if (!text.includes('"#e8590c"') || !/\n {2}size: 5/.test(text) || !text.includes(`  - ${rival.shortName}`)) throw new Error(`team settings not saved:\n${text}`)
})

await step('the GM’s profile, from the same page', async () => {
  await page.evaluate(([s, id]) => void (location.hash = `#/l/${encodeURIComponent(s)}/team/${id}`), [slug, team.id])
  await page.click('a:has-text("단장 로어")')
  await page.waitForSelector(`.lore-editor-title h2:has-text("${team.shortName} 단장")`)
  await page.click('.lore-tabs button:has-text("성향")')
  await page.fill('input[aria-label="단장 이름"]', '홍단장')
  await page.click('[role="radiogroup"][aria-label="운영 철학"] button:has-text("당장 우승")')
  await page.click('[role="radiogroup"][aria-label="모험심"] button:text-is("5")')
  await shot('lo09-gm')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  const text = readFileSync(join(loreDir, 'teams', team.shortName, `${team.shortName} 단장.md`), 'utf8')
  if (!/\nname: +홍단장 # 단장 이름/.test(text) || !text.includes('philosophy: win-now') || !/\n {2}risk: 5/.test(text)) throw new Error(`gm settings not saved:\n${text}`)
})

await step('a name in the locker room opens his page, and his lore from there', async () => {
  await page.evaluate(([s, id]) => void (location.hash = `#/l/${encodeURIComponent(s)}/team/${id}`), [slug, team.id])
  await page.click(`.mood-lore:has-text("${roster[1].name}")`)
  await page.waitForSelector(`.pstate-head h1:has-text("${roster[1].name}")`)
  await page.click('.pstate-head a:has-text("로어 편집")')
  await page.waitForSelector(`.lore-editor-title h2:has-text("${roster[1].name}")`)
  await page.waitForSelector(`.lore-item.on:has-text("${roster[1].name}")`)
})

await step('edit a whole school’s traits in the table, including a player with no file yet', async () => {
  const [a, b, c] = [roster[1], roster[2], roster[3]]
  // c's file is taken out first: editing him in the table makes it again.
  await invoke('lore.remove', slug, `teams/${team.shortName}/${c.name}.md`)
  await page.click('.lore-list-head button:has-text("표로 편집")')
  await page.waitForSelector('.lore-grid')
  await page.waitForSelector(`.lore-grid-name:has-text("${c.name}")`)
  // Keyboard: focus a cell and type the value; mouse: click the fourth step.
  await page.focus(`[aria-label="${a.name} 자존심"]`)
  await page.keyboard.press('5')
  await page.click(`[aria-label="${b.name} 볼 욕심"] .step >> nth=3`)
  await page.selectOption(`select[aria-label="${b.name} 인터뷰 스타일"]`, 'quiet')
  await page.click(`[aria-label="${c.name} 승부욕"] .step >> nth=0`)
  await page.waitForSelector('.lore-status.dirty:has-text("3개 바뀜")')
  await shot('lo10-table')
  await page.click('.lore-table-head button:has-text("3개 저장")')
  await page.waitForSelector('text=3개 파일을 저장했어요')
  const read = (p) => readFileSync(join(loreDir, 'teams', team.shortName, `${p.name}.md`), 'utf8')
  if (!/\n {2}ego: 5 +#/.test(read(a))) throw new Error(`a not saved:\n${read(a)}`)
  if (!/\n {2}usage: 4 +#/.test(read(b)) || !/\nmedia: quiet +#/.test(read(b))) throw new Error(`b not saved:\n${read(b)}`)
  if (!/\n {2}competitiveness: 1 +#/.test(read(c))) throw new Error(`c not made and saved:\n${read(c)}`)
})

await step('GMs and schools have their tables too', async () => {
  await page.click('.lore-table-head [role="radio"]:has-text("단장 성향표")')
  await page.selectOption(`select[aria-label="${team.shortName} 단장 운영 철학"]`, 'development')
  await page.click('.lore-table-head button:has-text("1개 저장")')
  await page.waitForSelector('text=1개 파일을 저장했어요')
  if (!readFileSync(join(loreDir, 'teams', team.shortName, `${team.shortName} 단장.md`), 'utf8').includes('philosophy: development')) throw new Error('gm philosophy not saved')
  await page.click('.lore-table-head [role="radio"]:has-text("학교 팬 문화표")')
  await page.focus(`[aria-label="${team.shortName} 다혈질"]`)
  await page.keyboard.press('ArrowRight')
  await page.click('.lore-table-head button:has-text("1개 저장")')
  await page.waitForSelector('text=1개 파일을 저장했어요')
  if (!/\n {2}temperament: 4/.test(readFileSync(join(loreDir, 'teams', team.shortName, `${team.shortName}.md`), 'utf8'))) throw new Error('fan temperament not saved')
  await shot('lo11-schools')
  await page.click('.lore-table-head button:has-text("목록")')
  await page.waitForSelector('.lore-list')
})

await step('edit roster facts in a table, and rename a player whose lore follows him', async () => {
  const p = roster[4]
  const ovr = snap.config.ratings.columns.find((c) => c.kind === 'number')
  const grade = snap.config.ratings.columns.find((c) => c.kind === 'grade')
  await page.click('.nav a:has-text("로스터 편집")')
  await page.waitForSelector('.roster-grid')
  await page.selectOption('select[aria-label="학교"]', team.id)
  // Out of range: marked, and saving waits.
  await page.fill(`input[aria-label="${p.name} ${ovr.name}"]`, '200')
  await page.waitForSelector('text=빨간 칸을 고쳐야 저장할 수 있어요')
  await page.fill(`input[aria-label="${p.name} ${ovr.name}"]`, '93')
  await page.selectOption(`select[aria-label="${p.name} ${grade.name}"]`, 'A+')
  await page.fill(`input[aria-label="${p.name} 별명"]`, '불도저, 탱크')
  await page.click(`.roster-grid tr:has(input[aria-label="${p.name} 이름"]) .roster-notes`)
  await page.fill(`textarea[aria-label="${p.name} 메모"]`, '왼손잡이 빅맨.')
  // Someone's lore names the rival (written straight to the file, as in another editor); then he's renamed at his school.
  const refFile = fileOf(roster[1])
  writeFileSync(
    refFile,
    readFileSync(refFile, 'utf8').replace(
      'relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n',
      `relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n  - with: ${mate.name}\n    type: rival\n    strength: 3\n    visibility: public\n`,
    ),
  )
  await page.selectOption('select[aria-label="학교"]', mate.teamId)
  await page.fill(`input[aria-label="${mate.name} 이름"]`, '새이름')
  await page.waitForSelector('.lore-status.dirty:has-text("2명 바뀜")')
  await shot('lo12-roster')
  await page.click('.lore-table-head button:has-text("2명 저장")')
  await page.waitForSelector('text=2명을 저장했어요')
  await page.waitForSelector(`text=이름 변경: ${mate.name} → 새이름`)
  await page.waitForSelector('text=로어 파일도 새 이름으로 바꿨어요')
  await page.waitForSelector(`text=다른 로어 파일이 아직 '${mate.name}'`)
  await shot('lo13-roster-saved')
  const after = await invoke('leagues.snapshot', slug)
  const edited = after.players.find((x) => x.id === p.id)
  if (edited.ratings[ovr.id] !== 93 || edited.ratings[grade.id] !== 'A+' || edited.nicknames.join('|') !== '불도저|탱크' || edited.notes !== '왼손잡이 빅맨.') throw new Error(`roster not saved: ${JSON.stringify(edited)}`)
  if (after.players.find((x) => x.id === mate.id).name !== '새이름') throw new Error('rename not saved')
  const mateSchool = snap.teams.find((x) => x.id === mate.teamId).shortName
  if (!readFileSync(join(loreDir, 'teams', mateSchool, '새이름.md'), 'utf8').includes(`id: ${mate.name}`)) throw new Error('lore file not renamed')
})

await step('swap two teammates’ slots in the table; a half-done swap shows its issue and waits', async () => {
  const now = await invoke('leagues.snapshot', slug)
  // The school's last starter and its bench player trade places, as after a lineup change in 2K.
  const starter = now.config.roster.slots.filter((s) => s.starter).at(-1)
  const bench = now.config.roster.slots.find((s) => !s.starter)
  const mates = now.players.filter((p) => p.teamId === team.id)
  const a = mates.find((p) => p.slotId === starter.id)
  const b = mates.find((p) => p.slotId === bench.id)
  await page.selectOption('select[aria-label="학교"]', team.id)
  await page.waitForSelector('text=2K에서 라인업을 바꿨다면 여기서 슬롯을 맞춰 주세요')
  // Half done: the starter goes to the bench and nobody takes his place yet.
  await page.selectOption(`select[aria-label="${a.name} 포지션"]`, bench.id)
  await page.waitForSelector(`.roster-slot-issues >> text=${team.shortName}: ${starter.name} 자리가 비어요`)
  await page.waitForSelector(`.roster-slot-issues >> text=${team.shortName}: ${bench.name} 자리에 2명이 돼요`)
  await page.waitForSelector(`.roster-grid td.bad select[aria-label="${a.name} 포지션"]`)
  await page.waitForSelector('text=빨간 칸을 고쳐야 저장할 수 있어요')
  if (await page.isEnabled('.lore-table-head button:has-text("1명 저장")')) throw new Error('a half-done swap could be saved')
  await shot('lo14-roster-half-swap')
  // The other half: the issue goes, and both save together.
  await page.selectOption(`select[aria-label="${b.name} 포지션"]`, starter.id)
  await page.waitForSelector('.roster-slot-issues', { state: 'detached' })
  await page.click('.lore-table-head button:has-text("2명 저장")')
  await page.waitForSelector('text=2명을 저장했어요')
  await shot('lo15-roster-swapped')
  const after = await invoke('leagues.snapshot', slug)
  const slotOf = (p) => after.players.find((x) => x.id === p.id).slotId
  if (slotOf(a) !== bench.id || slotOf(b) !== starter.id) throw new Error(`slots not swapped: ${a.name} ${slotOf(a)}, ${b.name} ${slotOf(b)}`)
})

await step('start a world topic', async () => {
  await page.click('.nav a:has-text("로어")')
  await page.waitForSelector('.lore-list')
  await page.click('.lore-item:has-text("새 세계관 문서")')
  await page.fill('input[aria-label="문서 제목 (예: 전국대회 결승)"]', '전국대회 결승')
  await page.click('button:has-text("파일 만들기")')
  await page.waitForSelector('.lore-editor-title h2:has-text("전국대회 결승")')
  await page.click('.lore-tabs button:has-text("설정")')
  await page.click('[role="radiogroup"][aria-label="종류"] button:has-text("사건")')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('text=저장했어요')
  if (!readFileSync(join(loreDir, 'world', '전국대회 결승.md'), 'utf8').includes('type: event')) throw new Error('world type not saved')
  await shot('lo10-world')
})

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) {
  console.log('page errors:\n' + errors.join('\n'))
  await app.close()
  process.exit(1)
}
await app.close()
console.log('lore e2e passed')
