import type { CardRow, DraftActionRow } from '@shared/season'
import { readDraftOutlook, type DraftOutlook, type SchoolCards } from '@data/draftOutlook'
import type { League } from './context'
import { particle } from './wiki'

/**
 * What writers are told about the schools' draft cards (card-swap leagues
 * only): a line a school, for every school (trade, draft and GM threads and
 * topics) or only the ones a story names. Before the draft: the cards each
 * holds (its own and others' by name, "누리고 2번"), the ones it traded away,
 * what the in-season cap leaves it, the cards it's on track to have when the
 * draft comes (projectedDraftCards), and its two best players, the ones it
 * would protect. During the draft: the pick order, the card on the clock, the
 * latest moves, and each school's cards left, protections and players in and
 * out. Every number is written the way writers should repeat it.
 */

type Names = Pick<League, 'teams' | 'players'>
const school = (league: Names, id: string) => league.teams.get(id)?.shortName ?? id
const player = (league: Names, id: string) => league.players.get(id)?.name ?? id

/** Latest moves the full draft table lists. */
const RECENT_MOVES = 8

/** Phases the in-season card cap counts in. */
const IN_SEASON = new Set(['preseason', 'regular'])

/** Season labels by id, for cards from another season. */
type Label = (seasonId: number) => string

/**
 * Cards by name, a school's numbers together ("자기 1·2번, 누리고 3번"); a
 * card from another season says which ("누리고 1번(시즌 1)"). `owner`'s own
 * cards read 자기.
 */
function cardList(league: Names, cards: readonly CardRow[], owner: string | null, seasonId: number, label: Label): string {
  const groups: { key: string; name: string; from: string; numbers: number[] }[] = []
  for (const c of cards) {
    const key = `${c.originalTeamId}:${c.issuedSeasonId}`
    const group = groups.find((g) => g.key === key)
    if (group) group.numbers.push(c.number)
    else
      groups.push({
        key,
        name: c.originalTeamId === owner ? '자기' : school(league, c.originalTeamId),
        from: c.issuedSeasonId === seasonId ? '' : `(${label(c.issuedSeasonId)})`,
        numbers: [c.number],
      })
  }
  return groups.map((g) => `${g.name} ${g.numbers.join('·')}번${g.from}`).join(', ')
}

/** Its two best players, the OVR beside each when the league has one. */
const core = (league: Names, s: SchoolCards) =>
  s.roster
    .slice(0, 2)
    .map((p) => `${player(league, p.playerId)}${p.overall !== null ? `(OVR ${p.overall})` : ''}`)
    .join(', ')

/** What the in-season cap counts for this school, and its unit. */
function capUse(o: DraftOutlook, s: SchoolCards): { what: string; unit: string; used: number } | null {
  if (!o.cap) return null
  if (o.cap.counts === 'given') return { what: '내준 카드', unit: '장', used: s.inSeason.given }
  if (o.cap.counts === 'received') return { what: '받은 카드', unit: '장', used: s.inSeason.received }
  return { what: '카드 트레이드', unit: '번', used: s.inSeason.trades }
}

/** A school before the draft: cards held, sent away, the cap, what it's on track to have, its best two. */
function beforeLine(league: Names, o: DraftOutlook, s: SchoolCards, label: Label): string {
  // Before any game the table's order is a coin flip: no place.
  const name = o.final || o.played > 0 ? `${school(league, s.teamId)} ${s.rank}위` : school(league, s.teamId)
  if (s.frozen) return `${name}: 동결 학교, 카드 없음, 드래프트 불참`
  // Before the season's cards are handed out, no cards is nothing to say (the heading says when they come).
  const parts = s.held.length ? [`카드 ${s.held.length}장(${cardList(league, s.held, s.teamId, o.seasonId, label)})`] : o.phase === 'preseason' ? [] : ['카드 0장']
  if (s.sent.length) {
    const to = [...new Set(s.sent.map((x) => x.to))]
    parts.push(`내준 카드 ${to.map((t) => `${cardList(league, s.sent.filter((x) => x.to === t).map((x) => x.card), s.teamId, o.seasonId, label)}→${school(league, t)}`).join(', ')}`)
  }
  const cap = IN_SEASON.has(o.phase) ? capUse(o, s) : null
  if (cap && o.cap && cap.used > 0) {
    const left = o.cap.limit - cap.used
    parts.push(`시즌 중 ${cap.what} ${cap.used}${cap.unit}(${left > 0 ? `한도까지 ${left}${cap.unit} 남음` : '한도 다 씀'})`)
  }
  // +n: the cards its place still brings when the playoffs end.
  if (o.final) parts.push(`드래프트 때 ${s.projected}장${s.toCome > 0 ? `(+${s.toCome})` : ''}`)
  else if (o.phase === 'regular' && o.played > 0) parts.push(`드래프트 예상 ${s.projected}장${s.toCome > 0 ? `(+${s.toCome})` : ''}`)
  const best = core(league, s)
  if (best) parts.push(`핵심 ${best}`)
  return `${name}: ${parts.join(' · ')}`
}

/** A move in the draft room, as the live thread names it. */
function moveText(league: Names, a: DraftActionRow): string {
  if (a.kind === 'pass') return `${school(league, a.teamId)} 패스`
  if (a.kind === 'protect') return `${school(league, a.teamId)} ${player(league, a.playerId ?? '')} 보호`
  return `${school(league, a.teamId)}: ${player(league, a.playerId ?? '')} 주고 ${school(league, a.targetTeamId ?? '')} ${player(league, a.targetPlayerId ?? '')} 데려옴`
}

/** A school in the draft: its pick slot, cards left, whom it protected, who came and went, passes. */
function roomLine(league: Names, o: DraftOutlook, s: SchoolCards, label: Label): string {
  const room = o.room!
  const name = school(league, s.teamId)
  if (s.frozen) return `${name}: 동결 학교, 드래프트 불참`
  const mine = room.actions.filter((a) => a.teamId === s.teamId || a.targetTeamId === s.teamId)
  const swaps = mine.filter((a) => a.kind === 'swap')
  const ours = (a: DraftActionRow) => a.teamId === s.teamId
  const came = swaps.map((a) => (ours(a) ? `${player(league, a.targetPlayerId ?? '')}(${school(league, a.targetTeamId ?? '')}에서)` : `${player(league, a.playerId ?? '')}(${school(league, a.teamId)}에서)`))
  const went = swaps.map((a) => (ours(a) ? `${player(league, a.playerId ?? '')}(→${school(league, a.targetTeamId ?? '')})` : `${player(league, a.targetPlayerId ?? '')}(→${school(league, a.teamId)})`))
  const kept = mine.filter((a) => a.kind === 'protect' && ours(a)).map((a) => player(league, a.playerId ?? ''))
  const passes = mine.filter((a) => a.kind === 'pass' && ours(a)).length
  const slot = room.order.indexOf(s.teamId) + 1
  const parts = [
    `남은 카드 ${s.held.length}장${s.held.length ? `(${cardList(league, s.held, s.teamId, o.seasonId, label)})` : ''}`,
    kept.length ? `보호 ${kept.join(', ')}` : '',
    came.length ? `데려옴 ${came.join(', ')}` : '',
    went.length ? `내줌 ${went.join(', ')}` : '',
    passes ? `패스 ${passes}번` : '',
  ].filter(Boolean)
  return `${name}${slot > 0 ? `(지명 ${slot}번째)` : ''}: ${parts.join(' · ')}`
}

function seasonLabels(league: League): Label {
  const labels = new Map((league.db.prepare('SELECT id, label FROM seasons').all() as { id: number; label: string }[]).map((s) => [s.id, s.label]))
  return (id) => labels.get(id) ?? ''
}

/**
 * One school's line as the card table has it (no bullet): for a chatter
 * topic's facts or an analysis pack. Null for a league without the card-swap
 * draft, or for a school it doesn't know.
 */
export function schoolCards(league: League, outlook: DraftOutlook | null, teamId: string): string | null {
  const s = outlook?.schools.find((x) => x.teamId === teamId)
  if (!outlook || !s) return null
  return outlook.room ? roomLine(league, outlook, s, seasonLabels(league)) : beforeLine(league, outlook, s, seasonLabels(league))
}

/**
 * The card table: every school ('all') or only these. '' for a league
 * without the card-swap draft, or when none of the named schools is in it.
 * `outlook` is read from the league when not given.
 */
export function cardsBlock(league: League, who: 'all' | readonly string[], outlook: DraftOutlook | null = readDraftOutlook(league.db)): string {
  if (!outlook) return ''
  const all = who === 'all'
  const wanted = all ? null : new Set(who)
  const schools = outlook.schools.filter((s) => !wanted || wanted.has(s.teamId))
  if (schools.length === 0) return ''
  const label = seasonLabels(league)
  const o = outlook
  if (o.room) {
    const room = o.room
    const state = room.protectionOpen ? '보호 단계 진행 중' : room.next ? '지명 진행 중' : '지명 끝, 마감만 남음'
    const moves = room.actions.filter((a) => a.kind !== 'protect')
    const order = new Map(room.order.map((t, i) => [t, i]))
    const ordered = [...schools].sort((a, b) => (order.get(a.teamId) ?? room.order.length) - (order.get(b.teamId) ?? room.order.length))
    const owner = room.next ? school(league, room.next.ownerTeamId) : ''
    return [
      `# 드래프트 현황 (${state}. 숫자는 여기 적힌 그대로)`,
      all ? `지명 순서: ${room.order.map((t) => school(league, t)).join(' → ')}` : '',
      room.next ? `다음 차례: ${cardList(league, [room.next], null, o.seasonId, label)} 카드(${owner}${particle(owner, '이', '가')} 쓴다)` : '',
      all && moves.length ? `지금까지 지명과 패스 ${moves.length}번, 최근: ${moves.slice(-RECENT_MOVES).map((a) => moveText(league, a)).join(' / ')}` : '',
      ...ordered.map((s) => `- ${roomLine(league, o, s, label)}`),
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (o.phase === 'offseason') {
    const holding = schools.filter((s) => s.held.length > 0)
    return [
      '# 드래프트 카드 (비시즌: 이번 드래프트는 끝났다)',
      o.schools.every((s) => s.held.length === 0) ? `- 쓰지 않은 카드는 남아 있지 않다. 다음 시즌 개막 때 학교마다 ${o.guaranteed}장씩 새로 받는다.` : '',
      ...holding.map((s) => `- ${school(league, s.teamId)}: 다음 시즌으로 넘어갈 카드 ${s.held.length}장(${cardList(league, s.held, s.teamId, o.seasonId, label)})`),
    ]
      .filter(Boolean)
      .join('\n')
  }
  const head =
    o.phase === 'preseason'
      ? `# 학교별 드래프트 카드 (개막 전이라 순위는 아직 없다. 개막 때 학교마다 ${o.guaranteed}장씩 받는다. 숫자는 여기 적힌 그대로)`
      : o.final
        ? '# 학교별 드래프트 카드 (최종 순위 확정, (+n)은 플레이오프가 끝나면 더 받는 카드. 숫자는 여기 적힌 그대로)'
        : '# 학교별 드래프트 카드 (예상은 지금 순위 그대로 끝날 때, (+n)은 그 순위로 더 받는 카드. 숫자는 여기 적힌 그대로)'
  const cap =
    !o.cap || !IN_SEASON.has(o.phase)
      ? ''
      : o.cap.limit === 0
        ? '시즌 중에는 카드 트레이드를 할 수 없다'
        : `시즌 중 카드 트레이드 한도: 학교마다 ${o.cap.counts === 'given' ? `내준 카드 ${o.cap.limit}장` : o.cap.counts === 'received' ? `받은 카드 ${o.cap.limit}장` : `카드 트레이드 ${o.cap.limit}번`}까지`
  return [head, cap, ...schools.map((s) => `- ${beforeLine(league, o, s, label)}`)].filter(Boolean).join('\n')
}

/**
 * Words that make what you wrote about trades, cards or the draft: a reply
 * to your post or comment then gets every school's cards, and your news the
 * rules and its schools' cards.
 */
export const MARKET_WORDS = /트레이드|카드|드래프트|보호|지명|스왑|단장/
