import { z } from 'zod'
import type { JobKind, JobRow } from '@ai/queue'
import { scoreDeal, strengthNow, type Scored } from '@core/market'
import { cardSequence, legalTargets, type DraftState } from '@core/draft'
import { type ModelName, aiFor, type EffortLevel } from '@shared/config/schema'
import { transaction, type Db } from '@data/db'
import { addNote, memoryOf } from '@data/gm'
import { currentSeason, listTeams, loadConfig } from '@data/league'
import { draftMove, draftView } from '@data/moves'
import { RuleError } from '@data/rules'
import { readLeague, short, type League } from '@story/context'
import { GM_STYLE, personaBlock, readMarket, type GmHooks, type MarketData } from './gm'

/**
 * The AI GMs in the card-swap draft. When the draft begins, each AI team
 * decides whom to protect (`gm_protect`, a few teams per call). Once you
 * close protection, picks run in turn order (`gm_swap`, several turns per
 * call): each GM ranks up to three of the legal swaps code listed for it, and
 * code takes the first that's still possible when its turn comes. A team you
 * run stops the AI until you've moved. Every move goes through the League
 * engine's draft rules.
 */

export const GM_PROTECT = 'gm_protect'
export const GM_SWAP = 'gm_swap'
/** Just above trade work (18): the draft is the event of the offseason. */
export const DRAFT_PRIORITY = 19
const TEAMS_PER_PROTECT = 6
const CARDS_PER_SWAP = 8
const OPTIONS_PER_CARD = 6
/** A swap that makes a team this much stronger (strength points) makes it a threat to the player it takes; OVR-led values sit closer together than the old average (1 then). */
const THREAT_GAIN = 0.75

// ── The draft as code sees it ────────────────────────────────────────────

export interface DraftData {
  league: League
  data: MarketData
  state: DraftState
  /** Teams run by the AI. */
  ai: Set<string>
  /** Where each player is now. */
  teamOf: Map<string, string>
  /** Targets you vetoed, per card: the AI doesn't pick them again with that card. */
  vetoed: Map<number, Set<string>>
}

export function readDraft(db: Db, folder: string): DraftData {
  const league = readLeague(db, folder)
  const view = draftView(db)
  const { config } = loadConfig(db)
  if (config.draft.kind !== 'card-swap') throw new Error('not a card-swap draft')
  const teams = listTeams(db)
  const players = league.db.prepare('SELECT id, team_id, slot_id FROM players').all() as { id: string; team_id: string; slot_id: string | null }[]
  // Swapped either way or traded during the draft: protected for the rest of it, so never an option.
  const moved = new Set(view.movedPlayers)
  const vetoed = new Map<number, Set<string>>()
  for (const v of db
    .prepare("SELECT card_id, target_player_id FROM draft_actions WHERE season_id = ? AND kind = 'swap' AND vetoed_at IS NOT NULL")
    .all(currentSeason(db).id) as { card_id: number; target_player_id: string }[]) {
    vetoed.set(v.card_id, new Set([...(vetoed.get(v.card_id) ?? []), v.target_player_id]))
  }
  return {
    teamOf: new Map(players.map((p) => [p.id, p.team_id])),
    vetoed,
    league,
    data: readMarket(league),
    state: {
      draft: config.draft,
      cards: view.cards,
      players: players.map((p) => ({ id: p.id, teamId: p.team_id, slotId: p.slot_id })),
      frozen: new Set(teams.filter((t) => t.control === 'frozen').map((t) => t.id)),
      protectedPlayers: new Set(view.protectedPlayers),
      movedPlayers: moved,
      protectionOpen: view.protectionOpen,
      order: view.order,
    },
    ai: new Set(teams.filter((t) => t.control === 'ai').map((t) => t.id)),
  }
}

const name = (league: League, id: string) => league.players.get(id)?.name ?? id
const slotName = (league: League, slotId: string | null) => league.config.roster.slots.find((s) => s.id === slotId)?.name ?? ''
const round1 = (n: number) => Math.round(n * 10) / 10

function playerLabel(d: DraftData, id: string): string {
  const p = d.data.market.players.find((x) => x.id === id)
  const ovr = d.data.ovr(id)
  return `${name(d.league, id)}(${short(d.league, p?.teamId ?? '')} ${slotName(d.league, p?.slotId ?? null)}${ovr !== null ? ` · OVR ${ovr}` : ''})`
}

/** A swap with this team's card, as a deal: it gives `own`, takes `target` from his team. */
function swapScore(d: DraftData, teamId: string, own: string, target: string): Scored {
  const victim = d.teamOf.get(target)!
  return scoreDeal(d.data.market, { a: teamId, b: victim, aGives: [own], bGives: [target], aCards: [], bCards: [] })
}

/**
 * The legal swaps worth offering a team on its turn with a card, best for it
 * first (one per target, for variety). Targets you vetoed with that card are
 * left out.
 */
export function swapOptions(d: DraftData, teamId: string, cardId: number, limit = OPTIONS_PER_CARD): Scored[] {
  const own = d.state.players.filter((p) => p.teamId === teamId && !d.state.movedPlayers.has(p.id))
  const vetoed = d.vetoed.get(cardId) ?? new Set<string>()
  const out: Scored[] = []
  for (const o of own) for (const t of legalTargets(d.state, teamId, o.id)) if (!vetoed.has(t.id)) out.push(swapScore(d, teamId, o.id, t.id))
  out.sort((x, y) => y.ua - x.ua)
  const seen = new Set<string>()
  const picked: Scored[] = []
  for (const s of out) {
    if (picked.length >= limit) break
    if (s.ua <= 0 || seen.has(s.deal.bGives[0]!)) continue
    seen.add(s.deal.bGives[0]!)
    picked.push(s)
  }
  return picked
}

/**
 * How exposed each of a team's players is: how many teams could take him
 * for their weakest player and come out stronger.
 */
function threats(d: DraftData, teamId: string, weakest: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  const others = [...new Set(d.state.players.map((p) => p.teamId))].filter((t) => t !== teamId && !d.state.frozen.has(t))
  for (const p of d.state.players.filter((x) => x.teamId === teamId)) {
    let n = 0
    for (const o of others) {
      const worst = weakest.get(o)
      if (!worst) continue
      const s = scoreDeal(d.data.market, { a: o, b: teamId, aGives: [worst], bGives: [p.id], aCards: [], bCards: [] })
      if (s.a.after - s.a.before >= THREAT_GAIN) n++
    }
    out.set(p.id, n)
  }
  return out
}

function teamLine(d: DraftData, teamId: string): string {
  const order = d.state.order.indexOf(teamId) + 1
  const cards = d.state.cards.filter((c) => c.ownerTeamId === teamId && c.status === 'held')
  return `${short(d.league, teamId)} · 지명 순서 ${order}/${d.state.order.length} · 전력 ${round1(strengthNow(d.data.market, teamId))} · 남은 카드 ${cards.length}장`
}

function rulesBlock(d: DraftData): string {
  const r = d.state.draft
  return [
    `# 드래프트 규칙`,
    `- 보호: 카드 한 장으로 자기 선수 한 명을 지킨다. 보호에는 그 팀의 가장 늦은 차례 카드가 쓰인다(마지막 지명 기회를 내주는 셈).`,
    `- 지명: 자기 차례에 카드 한 장으로, 자기 선수 한 명과 다른 학교의 보호되지 않은 선수 한 명을 맞바꾼다. 상대 학교는 거부할 수 없다. 맞바뀐 두 선수는 그 뒤로 드래프트가 끝날 때까지 보호된다.`,
    r.slotRule === 'same-slot' ? `- 같은 포지션끼리만 바꿀 수 있다.` : '',
    `- 한 선수는 한 드래프트에서 한 번만 옮긴다(맞바꿔 데려온 선수도 다시 내보내거나 빼앗길 수 없다). 지명 대신 패스할 수 있다.`,
  ]
    .filter(Boolean)
    .join('\n')
}

// ── gm_protect ───────────────────────────────────────────────────────────

export interface GmProtectInput {
  model: ModelName
  /** Claude Code's --effort for this job (left out: its default). */
  effort?: EffortLevel
  seasonId: number
  context: string
  teams: { key: string; teamId: string; players: { key: string; playerId: string }[] }[]
}

const protectSchema = z.object({
  teams: z
    .array(
      z.object({
        team: z.string().describe('팀 기호(T1 등)'),
        protect: z.array(z.string()).default([]).describe('보호할 선수 기호(P1 등), 카드 수 이내'),
        note: z.string().describe('속마음: 왜 이렇게 지켰는지 1~2문장'),
        quote: z.string().nullable().optional().describe('기자에게 한 공개 발언 한 문장, 없으면 null'),
      }),
    )
    .default([]),
})
export type GmProtectOutput = z.infer<typeof protectSchema>

export function protectInputs(db: Db, folder: string, only?: Set<string>): GmProtectInput[] {
  const d = readDraft(db, folder)
  const teams = d.state.order.filter((t) => d.ai.has(t) && d.state.cards.some((c) => c.ownerTeamId === t && c.status === 'held') && (!only || only.has(t)))
  // Each school's weakest player, once: what another school would give up to take someone.
  const weakest = new Map<string, { id: string; value: number }>()
  for (const p of d.data.market.players) {
    const w = weakest.get(p.teamId)
    if (!w || p.value < w.value) weakest.set(p.teamId, { id: p.id, value: p.value })
  }
  const weakestIds = new Map([...weakest].map(([t, w]) => [t, w.id]))
  const out: GmProtectInput[] = []
  for (let i = 0; i < teams.length; i += TEAMS_PER_PROTECT) {
    const batch = teams.slice(i, i + TEAMS_PER_PROTECT).map((teamId, j) => {
      const roster = d.data.market.players.filter((p) => p.teamId === teamId).sort((a, b) => b.value - a.value)
      return { key: `T${j + 1}`, teamId, players: roster.map((p, k) => ({ key: `P${k + 1}`, playerId: p.id })) }
    })
    const blocks = batch.map((t) => {
      const threat = threats(d, t.teamId, weakestIds)
      return [
        `# ${t.key} · ${teamLine(d, t.teamId)}`,
        personaBlock(d.league, d.data, t.teamId),
        ...t.players.map((p) => {
          const mp = d.data.market.players.find((x) => x.id === p.playerId)!
          const band = d.data.bands.get(p.playerId)
          return `${p.key} · ${playerLabel(d, p.playerId)} · 가치 ${round1(mp.value)}${band && ['unhappy', 'boiling'].includes(band) ? ' · 불만' : ''} · 노릴 만한 팀 ${threat.get(p.playerId) ?? 0}곳`
        }),
      ].join('\n')
    })
    out.push({ ...aiFor(d.league.config, 'gmDraft'), seasonId: currentSeason(db).id, context: [rulesBlock(d), ...blocks].join('\n\n'), teams: batch })
  }
  return out
}

// ── gm_swap ──────────────────────────────────────────────────────────────

export interface GmSwapInput {
  model: ModelName
  /** Claude Code's --effort for this job (left out: its default). */
  effort?: EffortLevel
  seasonId: number
  context: string
  /** `from`: the school the target was at when the batch was written (he may have moved since). */
  cards: { key: string; cardId: number; teamId: string; options: { key: string; own: string; target: string; from: string }[] }[]
}

const swapSchema = z.object({
  picks: z
    .array(
      z.object({
        card: z.string().describe('차례 기호(K1 등)'),
        choices: z.array(z.string()).default([]).describe('원하는 순서대로 지명 기호(S1 등) 최대 3개. 패스하려면 ["pass"]'),
        ifGone: z.enum(['best', 'pass']).default('best').describe('고른 선수가 모두 먼저 뽑혔을 때: best(남은 것 중 최선) / pass'),
        note: z.string().describe('속마음: 왜 이 선수를 노렸는지 1~2문장'),
        quote: z.string().nullable().optional().describe('지명 직후 공개 발언 한 문장, 없으면 null'),
      }),
    )
    .default([]),
})
export type GmSwapOutput = z.infer<typeof swapSchema>

/**
 * The next few AI turns in order, each with its legal options as things
 * stand now. Stops at a turn belonging to a team you run. Null when it isn't
 * an AI team's turn (or the draft is over).
 */
export function swapInput(db: Db, folder: string): GmSwapInput | null {
  const d = readDraft(db, folder)
  if (d.state.protectionOpen) return null
  const view = draftView(db)
  // The cards still to play, in turn order from the next one on.
  const ordered = cardSequence(view.cards, view.order, d.state.draft.turns).filter((c) => c.status === 'held')
  if (!view.next || ordered[0]?.id !== view.next.id) return null
  const cards: GmSwapInput['cards'] = []
  for (const c of ordered) {
    if (cards.length >= CARDS_PER_SWAP || !d.ai.has(c.ownerTeamId)) break
    const options = swapOptions(d, c.ownerTeamId, c.id).map((s, i) => ({ key: `S${i + 1}`, own: s.deal.aGives[0]!, target: s.deal.bGives[0]!, from: s.deal.b }))
    cards.push({ key: `K${cards.length + 1}`, cardId: c.id, teamId: c.ownerTeamId, options })
  }
  if (cards.length === 0) return null
  const blocks = cards.map((c) => {
    const mem = memoryOf(db, c.teamId)
    const lines = c.options.map((o) => {
      const s = swapScore(d, c.teamId, o.own, o.target)
      const victim = d.teamOf.get(o.target)!
      const trust = mem.trust[victim]
      return `${o.key} · ${playerLabel(d, o.own)} 내주고 ← ${playerLabel(d, o.target)} 데려옴 · 우리 전력 ${round1(s.a.before)}→${round1(s.a.after)} · ${short(d.league, victim)} 전력 ${round1(s.b.before)}→${round1(s.b.after)}${trust ? ` · ${short(d.league, victim)} 단장에 대한 신뢰 ${trust}` : ''}`
    })
    const vetoed = [...(d.vetoed.get(c.cardId) ?? [])]
    return [
      `# ${c.key} · ${teamLine(d, c.teamId)}`,
      personaBlock(d.league, d.data, c.teamId),
      vetoed.length ? `커미셔너가 이 차례의 지명을 거부했다(다시 못 데려옴): ${vetoed.map((id) => name(d.league, id)).join(', ')}` : '',
      ...(lines.length ? lines : ['(쓸 만한 지명이 없다: 패스)']),
    ]
      .filter(Boolean)
      .join('\n')
  })
  return {
    ...aiFor(d.league.config, 'gmDraft'),
    seasonId: currentSeason(db).id,
    context: [rulesBlock(d), `# 이번 차례들 (K1부터 순서대로 지명한다. 앞 차례가 먼저 데려간 선수는 뒤 차례에서 못 데려간다)`, ...blocks].join('\n\n'),
    cards,
  }
}

const STYLE_DRAFT = `이번에는 카드 드래프트다. 단장마다 운영 철학과 성향, 다른 단장에 대한 신뢰(낮으면 그 학교에서 빼 오는 복수 지명도 한다)를 따른다. 고를 수 있는 것은 자료의 기호뿐이고, 속마음과 발언에는 기호 대신 선수 이름을 쓴다.`

const PROTECT_INSTRUCTIONS = `${STYLE_DRAFT}
각 팀(T1…)이 보호할 선수를 정한다. teams에 팀마다 하나씩.
- 보호는 카드를 쓴다: 그만큼 늦은 지명 기회를 잃는다. 에이스나 노리는 팀이 많은 선수를 지키고, 내줘도 되는 선수는 지키지 않는다.
- 카드 수보다 많이 보호할 수 없다. 아무도 지키지 않아도 된다.`

const SWAP_INSTRUCTIONS = `${STYLE_DRAFT}
각 차례(K1…)의 지명을 정한다. picks에 차례마다 하나씩.
- choices에 원하는 지명을 순서대로 최대 3개(앞 차례가 먼저 데려가면 다음 것을 쓴다). 쓸 만한 게 없으면 ["pass"].
- ifGone: 고른 선수가 모두 먼저 뽑혔을 때 남은 것 중 최선으로 갈지(best), 패스할지(pass).
- note는 속마음, quote는 지명 직후 공개 발언(없으면 null).`

// ── Accepting results ────────────────────────────────────────────────────

const oneLine = (text: unknown, max = 300) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const keyOf = (text: unknown) => oneLine(text, 10).toUpperCase()

function saveNote(db: Db, seasonId: number, teamId: string, kind: 'protect' | 'swap' | 'pass', actionId: number | null, cardId: number | null, note: string, quote: string | null, jobId: number | null): void {
  db.prepare('INSERT INTO draft_notes (season_id, team_id, kind, action_id, card_id, note, quote, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    seasonId,
    teamId,
    kind,
    actionId,
    cardId,
    note,
    quote,
    jobId,
    new Date().toISOString(),
  )
}

const notesSaved = (db: Db, jobId: number) => Boolean(db.prepare('SELECT 1 FROM draft_notes WHERE job_id = ? LIMIT 1').get(jobId))

function acceptProtect(db: Db, folder: string, output: GmProtectOutput, job: JobRow, hooks: GmHooks): void {
  const input = job.input as GmProtectInput
  if (notesSaved(db, job.id)) return
  let changed = false
  // A team you took over (리그 설정) since the job was written is yours to protect for.
  const ai = new Set(listTeams(db).filter((t) => t.control === 'ai').map((t) => t.id))
  transaction(db, () => {
    for (const t of input.teams) {
      if (!ai.has(t.teamId)) continue
      const answer = output.teams.find((x) => keyOf(x.team) === t.key)
      const wanted = [...new Set((answer?.protect ?? []).map(keyOf))].map((k) => t.players.find((p) => p.key === k)?.playerId).filter((id): id is string => Boolean(id))
      const note = oneLine(answer?.note ?? '')
      const quote = oneLine(answer?.quote ?? '', 200) || null
      let any = false
      for (const playerId of wanted) {
        try {
          const actionId = draftMove(db, { kind: 'protect', teamId: t.teamId, playerId })
          saveNote(db, input.seasonId, t.teamId, 'protect', actionId, null, note, quote, job.id)
          any = changed = true
        } catch (e) {
          // Out of cards, protection closed meanwhile, or already protected: the rest just don't happen.
          if (!(e instanceof RuleError)) throw e
        }
      }
      if (!any) saveNote(db, input.seasonId, t.teamId, 'protect', null, null, note || '보호하지 않음', quote, job.id)
    }
  })
  if (changed) hooks.changed()
}

/** Whether a card is the next to play, and still its team's (not traded away meanwhile). */
function onTurn(db: Db, cardId: number, teamId: string): boolean {
  const view = draftView(db)
  return view.next?.id === cardId && view.next.ownerTeamId === teamId
}

/**
 * Plays a turn without Claude: the team's best legal swap if it's clearly
 * worth it, otherwise a pass. Used when a turn has nothing worth asking
 * about, or when Claude didn't answer for it twice.
 */
export function autoPlay(db: Db, folder: string, cardId: number, teamId: string, why: string): boolean {
  if (!onTurn(db, cardId, teamId)) return false
  const seasonId = currentSeason(db).id
  return transaction(db, () => {
    const best = swapOptions(readDraft(db, folder), teamId, cardId, 1)[0]
    if (best && best.ua > 0.3) {
      try {
        const actionId = draftMove(db, { kind: 'swap', teamId, cardId, playerId: best.deal.aGives[0]!, targetPlayerId: best.deal.bGives[0]! })
        saveNote(db, seasonId, teamId, 'swap', actionId, cardId, why, null, null)
        return true
      } catch (e) {
        if (!(e instanceof RuleError)) throw e
      }
    }
    const actionId = draftMove(db, { kind: 'pass', teamId, cardId })
    saveNote(db, seasonId, teamId, 'pass', actionId, cardId, why, null, null)
    return true
  })
}

function acceptSwap(db: Db, folder: string, output: GmSwapOutput, job: JobRow, hooks: GmHooks): void {
  const input = job.input as GmSwapInput
  if (notesSaved(db, job.id)) return
  const league = readLeague(db, folder)
  let changed = false
  const ai = new Set(listTeams(db).filter((t) => t.control === 'ai').map((t) => t.id))
  transaction(db, () => {
    for (const c of input.cards) {
      // Someone else moved meanwhile (you vetoed or played a turn, or the card was traded): the rest is stale.
      if (!onTurn(db, c.cardId, c.teamId)) break
      // You took this team over (리그 설정) since the batch was written: its turn waits for you.
      if (!ai.has(c.teamId)) break
      const answer = output.picks.find((x) => keyOf(x.card) === c.key)
      const note = oneLine(answer?.note ?? '')
      const quote = oneLine(answer?.quote ?? '', 200) || null
      let done = false
      let passed = false
      // Choices in order; a "pass" among them is where the GM stops.
      for (const k of (answer?.choices ?? []).map(keyOf).slice(0, 3)) {
        if (k === 'PASS') {
          passed = true
          break
        }
        const o = c.options.find((x) => x.key === k)
        if (!o) continue
        // He moved since the batch was written (a trade during the draft): not the deal the GM chose.
        const now = db.prepare('SELECT team_id FROM players WHERE id = ?').get(o.target) as { team_id: string } | undefined
        if (now?.team_id !== o.from) continue
        try {
          const actionId = draftMove(db, { kind: 'swap', teamId: c.teamId, cardId: c.cardId, playerId: o.own, targetPlayerId: o.target })
          saveNote(db, input.seasonId, c.teamId, 'swap', actionId, c.cardId, note, quote, job.id)
          addNote(db, c.teamId, `드래프트: ${name(league, o.target)} 지명`, Date.now())
          done = true
          break
        } catch (e) {
          if (!(e instanceof RuleError)) throw e
        }
      }
      // Everyone it wanted was taken first: its best swap left, if any is worth it (unless it said to pass then).
      if (!done && !passed && (answer?.ifGone ?? 'best') === 'best') {
        const best = swapOptions(readDraft(db, folder), c.teamId, c.cardId, 1)[0]
        if (best && best.ua > 0.3) {
          try {
            const actionId = draftMove(db, { kind: 'swap', teamId: c.teamId, cardId: c.cardId, playerId: best.deal.aGives[0]!, targetPlayerId: best.deal.bGives[0]! })
            saveNote(db, input.seasonId, c.teamId, 'swap', actionId, c.cardId, `${note} (원하던 선수가 먼저 뽑혀 차선책)`.trim(), quote, job.id)
            done = true
          } catch (e) {
            if (!(e instanceof RuleError)) throw e
          }
        }
      }
      if (!done) {
        try {
          const actionId = draftMove(db, { kind: 'pass', teamId: c.teamId, cardId: c.cardId })
          saveNote(db, input.seasonId, c.teamId, 'pass', actionId, c.cardId, note || '패스', quote, job.id)
        } catch (e) {
          if (!(e instanceof RuleError)) throw e
          break
        }
      }
      changed = true
    }
  })
  if (changed) hooks.changed()
}

// ── Kinds ────────────────────────────────────────────────────────────────

export function draftKinds(db: Db, folder: string, hooks: GmHooks): JobKind<any, any>[] {
  const style = () => hooks.style?.() ?? GM_STYLE
  const changed = () =>
    setImmediate(() => {
      try {
        hooks.changed()
      } catch (e) {
        console.warn('[gm] catching up after draft moves failed', e)
      }
    })
  const h: GmHooks = { ...hooks, changed }
  const inDraft = (seasonId: number) => {
    const s = currentSeason(db)
    return s.id === seasonId && s.phase === 'draft'
  }
  const protect: JobKind<GmProtectInput, GmProtectOutput> = {
    kind: GM_PROTECT,
    model: (input) => input.model,
    effort: (input) => input.effort,
    tools: [],
    output: protectSchema,
    systemPrompt: style,
    prompt: () => PROTECT_INSTRUCTIONS,
    stdin: (input) => input.context,
    timeoutMs: 8 * 60_000,
    stillWanted: (input) => inDraft(input.seasonId) && draftView(db).protectionOpen,
    accept: (output, job) => acceptProtect(db, folder, output, job, h),
  }
  const swap: JobKind<GmSwapInput, GmSwapOutput> = {
    kind: GM_SWAP,
    model: (input) => input.model,
    effort: (input) => input.effort,
    tools: [],
    output: swapSchema,
    systemPrompt: style,
    prompt: () => SWAP_INSTRUCTIONS,
    stdin: (input) => input.context,
    timeoutMs: 8 * 60_000,
    // Stale if the turn it was written for has passed, or the card changed hands.
    stillWanted: (input) => inDraft(input.seasonId) && input.cards[0] !== undefined && onTurn(db, input.cards[0].cardId, input.cards[0].teamId),
    accept: (output, job) => acceptSwap(db, folder, output, job, h),
  }
  return [protect, swap]
}

/** Demo answers: protect the best player, take the first option. */
export function draftDemo(kind: string, input: unknown): GmProtectOutput | GmSwapOutput | null {
  if (kind === GM_PROTECT) {
    const i = input as GmProtectInput
    return { teams: i.teams.map((t) => ({ team: t.key, protect: ['P1'], note: '에이스는 지킨다.', quote: null })) }
  }
  if (kind === GM_SWAP) {
    const i = input as GmSwapInput
    return {
      picks: i.cards.map((c, n) => ({
        card: c.key,
        choices: c.options.length ? c.options.slice(0, 3).map((o) => o.key) : ['pass'],
        ifGone: 'best' as const,
        note: '빈자리를 메울 선수다.',
        quote: n === 0 ? '원하던 선수를 데려왔습니다.' : null,
      })),
    }
  }
  return null
}
