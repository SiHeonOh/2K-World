import { join } from 'node:path'
import { hash32, rng, shuffle } from '@core/random'
import { type LeagueConfig, aiFor } from '@shared/config/schema'
import type { EventPayloads, LeagueEvent } from '@shared/events'
import { lastEventId, listPersonas, memoriesOf, personaCount, savePersonas, type PersonaRow } from '@data/community'
import type { Db } from '@data/db'
import { flagsFor, flagsOf } from '@data/flags'
import { tagUnverified } from '@shared/numbers'
import { playedMode, roundLabel } from '@shared/played'
import { currentSeason, listPlayers, listTeams, loadConfig } from '@data/league'
import { pollView } from '@data/polls'
import { boxLines, getGame, listGames, standings } from '@data/season'
import { roundComplete } from '@data/schedule'
import { rosterHistory } from '@data/moves'
import { linkLore, loadLoreFolder, loreBlock, type LeagueRefs, type LoreLinks } from '@lore/folder'
import type { DemoFacts } from './demo'
import { planTopics } from './topics'
import type { TopicKind } from '@shared/config/schema'
import { ARCHETYPES, makeCast } from './personas'
import type { StoryInput, StoryKind } from './jobs'
import { leagueFeelings } from './feelings'
import { CAST_HEADING } from './numbers'

/**
 * Builds what each story job reads: league facts, the game or event, lore
 * filtered by audience (writers never get 비밀), the cast for this job, and
 * what was already said. Everything is a snapshot taken when the job is queued.
 */

const PHASES: Record<string, string> = { preseason: '개막 전', regular: '정규시즌', playoffs: '플레이오프', draft: '드래프트', offseason: '비시즌' }

export interface League {
  db: Db
  config: LeagueConfig
  teams: Map<string, { id: string; shortName: string; name: string }>
  /** firstTeamId: his team before his first trade or swap, which is what 이름(학교) means. */
  players: Map<string, { id: string; name: string; teamId: string; firstTeamId: string }>
  lore: LoreLinks
}

/** Lore is re-read at most every few seconds, so an edit shows up almost at once. */
const LORE_TTL_MS = 5000
const loreCache = new Map<string, { at: number; entries: ReturnType<typeof loadLoreFolder>['entries'] }>()

function loreEntries(leagueFolder: string) {
  const dir = join(leagueFolder, 'lore')
  const hit = loreCache.get(dir)
  if (hit && Date.now() - hit.at < LORE_TTL_MS) return hit.entries
  const { entries } = loadLoreFolder(dir)
  loreCache.set(dir, { at: Date.now(), entries })
  return entries
}

/** Drops the cached lore, e.g. after files moved, so the next read sees the folder as it is. */
export function forgetLore(leagueFolder: string): void {
  loreCache.delete(join(leagueFolder, 'lore'))
}

/** What lore files are linked against: teams, and players with the team each started on and every team he's been on. */
export function loreRefs(db: Db): { teams: LeagueRefs['teams']; players: { id: string; name: string; teamId: string; firstTeamId: string; teamIds: string[] }[] } {
  const history = rosterHistory(db)
  return {
    teams: listTeams(db).map((t) => ({ id: t.id, shortName: t.shortName })),
    players: listPlayers(db).map((p) => {
      const h = history.get(p.id)
      return { id: p.id, name: p.name, teamId: p.teamId, firstTeamId: h?.first ?? p.teamId, teamIds: h ? [...new Set([...h.teams, p.teamId])] : [p.teamId] }
    }),
  }
}

export function readLeague(db: Db, leagueFolder: string): League {
  const { config } = loadConfig(db)
  const teams = listTeams(db)
  const refs = loreRefs(db)
  const entries = loreEntries(leagueFolder)
  return {
    db,
    config,
    teams: new Map(teams.map((t) => [t.id, { id: t.id, shortName: t.shortName, name: t.name }])),
    players: new Map(refs.players.map((p) => [p.id, { id: p.id, name: p.name, teamId: p.teamId, firstTeamId: p.firstTeamId }])),
    lore: linkLore(entries, refs),
  }
}

/** Makes the cast the first time the community opens; team lore's fan base size sets how many fans each school gets. */
export function ensureCast(league: League): void {
  if (personaCount(league.db) > 0) return
  const c = league.config.community
  const cast = makeCast({
    seed: `${currentSeason(league.db).seed}:${league.config.league.name}`,
    fans: c.fans,
    reporters: c.reporters,
    maxSpice: c.maxSpice,
    teams: [...league.teams.values()].map((t) => {
      const lore = league.lore.team.get(t.id)
      return { id: t.id, shortName: t.shortName, fanSize: lore?.kind === 'team' ? lore.settings.fans.size : 3 }
    }),
    players: [...league.players.values()],
  })
  savePersonas(league.db, cast, c.myNick)
}

/**
 * Text someone wrote (you, a writer, a persona's note), passed as data: one
 * line, in corner brackets, so it can't pose as one of the app's own blocks.
 */
export const said = (text: string, max = 300) => `「${text.replace(/[「」]/g, '"').replace(/\s+/g, ' ').trim().slice(0, max)}」`

export const short = (league: League, teamId: string) => league.teams.get(teamId)?.shortName ?? teamId

/** A school's conference name (null when it has none). */
function conferenceName(league: League, teamId: string): string | null {
  const row = league.db.prepare('SELECT division_id FROM teams WHERE id = ?').get(teamId) as { division_id: string } | undefined
  const division = league.config.structure.divisions.find((d) => d.id === row?.division_id)
  return league.config.structure.conferences.find((c) => c.id === division?.conferenceId)?.name ?? null
}
export const playerName = (league: League, id: string) => league.players.get(id)?.name ?? id

// ── Blocks ───────────────────────────────────────────────────────────────

export function leagueBlock(league: League): string {
  const season = currentSeason(league.db)
  const view = standings(league.db)
  const games = listGames(league.db, season.id)
  const finals = games.filter((g) => g.status === 'final').sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? '')).slice(0, 6)
  const upcoming = games.filter((g) => g.status === 'scheduled').slice(0, 4)
  const score = (g: (typeof games)[number]) => `${short(league, g.home)} ${g.homeScore} : ${g.awayScore} ${short(league, g.away)}`
  const round = (n: number) => roundLabel(league.config, n)
  const lines = [
    `# 리그`,
    `${league.config.league.name} · ${season.label} · ${PHASES[season.phase] ?? season.phase} · 정규시즌 ${view.played}/${view.total}경기 진행`,
    // 2K 일정대로: no rounds, and schools have played different numbers of games.
    ...(playedMode(league.config) ? [PLAYED_NOTE] : []),
    `# 순위 (상위 10)`,
    ...view.overall.slice(0, 10).map((s, i) => `${i + 1}. ${short(league, s.teamId)} ${s.wins}승 ${s.losses}패${s.streak ? ` (${s.streak})` : ''}`),
  ]
  if (finals.length) lines.push('# 최근 결과', ...finals.map((g) => `${round(g.round)} ${score(g)}`))
  if (upcoming.length) lines.push('# 다음 경기', ...upcoming.map((g) => `${round(g.round)} ${short(league, g.away)} @ ${short(league, g.home)}`))
  return lines.join('\n')
}

/** What writers are told about a 2K 일정대로 season: no rounds, and uneven games played. */
export const PLAYED_NOTE =
  '2K 일정대로 진행: 정해진 라운드 없이 그날그날 경기가 잡힌다(N일차는 커미셔너가 경기한 날 묶음). 학교마다 지금까지 치른 경기 수가 다르니 순위는 승률로 보고, 모든 학교가 같은 수만큼 뛰었다고 쓰지 않는다.'

export function statLine(stats: Record<string, number>): string {
  const n = (k: string) => stats[k] ?? 0
  return `${n('pts')}점 ${n('reb')}리바 ${n('ast')}어시${n('stl') ? ` ${n('stl')}스틸` : ''}${n('blk') ? ` ${n('blk')}블락` : ''} (야투 ${n('fgm')}/${n('fga')}, 3점 ${n('3pm')}/${n('3pa')})`
}

/** The game: score and each side's top scorers. Returns the players worth mentioning too. */
function gameBlock(league: League, gameId: number): { text: string; players: string[]; headline: string; teams: string[] } {
  const game = getGame(league.db, gameId)
  if (!game || game.homeScore === null || game.awayScore === null) return { text: '', players: [], headline: '', teams: [] }
  const lines = boxLines(league.db, gameId)
  const headline = `${short(league, game.home)} ${game.homeScore} : ${game.awayScore} ${short(league, game.away)}`
  const out = [`# 이 경기`, `${game.stage === 'regular' ? roundLabel(league.config, game.round) : `${game.stage} ${game.round}차전`} · ${headline} (홈: ${short(league, game.home)})`]
  const players: string[] = []
  for (const team of [game.home, game.away]) {
    const top = lines.filter((l) => l.teamId === team).sort((a, b) => (b.stats.pts ?? 0) - (a.stats.pts ?? 0)).slice(0, 5)
    if (top.length === 0) continue
    out.push(`${short(league, team)}: ${top.map((l) => `${playerName(league, l.playerId)} ${statLine(l.stats)}`).join(' / ')}`)
    players.push(...top.slice(0, 3).map((l) => l.playerId))
  }
  // Team totals: fans talk team shooting, and a total they add up themselves is a number the check can't vouch for.
  const totals = [game.home, game.away].flatMap((team) => {
    const mine = lines.filter((l) => l.teamId === team)
    if (mine.length === 0) return []
    const t = (k: string) => mine.reduce((s, l) => s + (l.stats[k] ?? 0), 0)
    return [`${short(league, team)} 야투 ${t('fgm')}/${t('fga')}, 3점 ${t('3pm')}/${t('3pa')}, 자유투 ${t('ftm')}/${t('fta')}, 리바 ${t('reb')}, 어시 ${t('ast')}, 턴오버 ${t('to')}`]
  })
  if (totals.length) out.push(`팀 합계: ${totals.join(' / ')}`)
  const margin = Math.abs(game.homeScore - game.awayScore)
  const notes: string[] = []
  if (margin <= 3) notes.push('접전')
  if (margin >= 20) notes.push('대승')
  const big = lines.filter((l) => (l.stats.pts ?? 0) >= 30)
  if (big.length) notes.push(`${big.map((l) => playerName(league, l.playerId)).join(', ')} 30점 이상`)
  if (notes.length) out.push(`화제: ${notes.join(', ')}`)
  // Players facing the school that sent them away without asking: the move was public, the grudge a rumor.
  const feelings = leagueFeelings(league)
  const revenge = [...league.players.values()].flatMap((p) => {
    const other = p.teamId === game.home ? game.away : p.teamId === game.away ? game.home : null
    const g = other ? feelings.get(p.id)?.grudges.find((x) => x.target.kind === 'team' && x.target.id === other && x.why === 'sent_away' && x.value <= -5) : undefined
    return g && other ? [`${p.name}(현 ${short(league, p.teamId)})는 원치 않게 ${short(league, other)}를 떠났다`] : []
  })
  if (revenge.length) out.push(`복수전(앙금은 소문으로만): ${revenge.join(', ')}`)
  return { text: out.join('\n'), players, headline, teams: [short(league, game.home), short(league, game.away)] }
}

/** Lore for the teams and players involved: 공개 for everyone, 소문 marked for rumor-minded writers. No 비밀, ever. */
export function loreFor(league: League, teamIds: string[], playerIds: string[]): string {
  const blocks: string[] = []
  const add = (entry: Parameters<typeof loreBlock>[0], title: string) => {
    const block = loreBlock(entry, title, 'rumor')
    if (block) blocks.push(block)
  }
  for (const id of new Set(teamIds)) add(league.lore.team.get(id), short(league, id))
  for (const id of new Set(playerIds)) add(league.lore.player.get(id), `${playerName(league, id)} (${short(league, league.players.get(id)?.teamId ?? '')})`)
  // Rivalries and topics that name one of them.
  const names = new Set([...teamIds.map((t) => short(league, t)), ...playerIds.map((p) => playerName(league, p))])
  for (const w of league.lore.world) {
    if (w.kind === 'world' && w.settings.involves.some((n) => names.has(n))) add(w, w.settings.id)
  }
  if (blocks.length === 0) return ''
  // Keep the pack bounded: the first entries get full text.
  let text = `# 로어\n${blocks.join('\n\n')}`
  if (text.length > 12_000) text = `${text.slice(0, 12_000)}\n(이하 생략)`
  return text
}

function castLine(league: League, p: PersonaRow): string {
  if (p.kind === 'reporter') return `${p.id} · ${p.nick} · 기자 (${p.outlet ?? ''}) · 기사체`
  const a = ARCHETYPES.find((x) => x.id === p.archetype)
  const parts = [
    p.id,
    `닉: ${p.nick}`,
    p.teamId ? `${short(league, p.teamId)} 팬` : '중립',
    a ? `${a.name}: ${a.style}` : p.archetype,
    `매운맛 ${p.spice}/5`,
  ]
  if (p.favPlayerId) parts.push(`최애: ${playerName(league, p.favPlayerId)}`)
  if (p.quirks.length) parts.push(`버릇: ${p.quirks.join(', ')}`)
  if (p.rumor) parts.push('소문 OK')
  const memory = memoriesOf(league.db, p.id, 2)
  if (memory.length) parts.push(`기억: ${memory.map((m) => said(m, 100)).join(' ')}`)
  return parts.join(' · ')
}

/** A cast for one job: fans of the schools involved first, then neutral and other fans, plus reporters. */
export function pickCast(league: League, opts: { teams: string[]; fans: number; reporters: number; salt: string }): PersonaRow[] {
  const all = listPersonas(league.db).filter((p) => p.kind !== 'user')
  const random = rng(hash32(opts.salt))
  const fans = shuffle(all.filter((p) => p.kind === 'fan'), random)
  // About 60% from the schools involved, split evenly between them; the rest neutral or other schools.
  const teams = [...new Set(opts.teams)]
  const quota = teams.length ? Math.ceil((opts.fans * 0.6) / teams.length) : 0
  const involved = teams.flatMap((t) => fans.filter((p) => p.teamId === t).slice(0, quota))
  const others = fans.filter((p) => !p.teamId || !teams.includes(p.teamId))
  const chosen = [...involved, ...others].slice(0, opts.fans)
  const reporters = shuffle(all.filter((p) => p.kind === 'reporter'), random).slice(0, opts.reporters)
  return [...chosen, ...reporters]
}

/** Who may write. Not facts: the number check skips this block (ids, nicknames, 매운맛 3/5, 기억). */
export function castBlock(league: League, cast: PersonaRow[], field = 'author'): string {
  return `${CAST_HEADING} (${field}에는 id를 그대로)\n${cast.map((p) => castLine(league, p)).join('\n')}`
}

/** AI text a writer reads again, with the numbers marked on it shown as unverified (and not counted as facts). */
const unverified = (db: Db, kind: 'post' | 'comment', ids: readonly number[]) => {
  const flags = flagsFor(db, kind, ids)
  return (id: number, text: string) => tagUnverified(text, flags.get(id))
}

function boardsBlock(league: League): string {
  return `# 게시판\n${league.config.community.boards
    .filter((b) => b.role !== 'poten')
    .map((b) => `${b.id}: ${b.name}`)
    .join('\n')}`
}

function coveredBlock(league: League): string {
  const titles = league.db.prepare('SELECT id, title FROM posts ORDER BY id DESC LIMIT 20').all() as { id: number; title: string }[]
  const tag = unverified(league.db, 'post', titles.map((t) => t.id))
  return titles.length ? `# 이미 나온 이야기 (같은 제목 금지)\n${titles.map((t) => `- ${tag(t.id, said(t.title, 100))}`).join('\n')}` : ''
}

function hotPosts(league: League, limit: number): { id: number; title: string; comments: number }[] {
  return league.db
    .prepare(
      `SELECT p.id, p.title, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments
       FROM posts p WHERE p.shown_at <= ? ORDER BY p.last_activity DESC, p.up DESC LIMIT ?`,
    )
    .all(new Date().toISOString(), limit) as { id: number; title: string; comments: number }[]
}

const boardOf = (league: League, role: string) =>
  (league.config.community.boards.find((b) => b.role === role) ?? league.config.community.boards.find((b) => b.role === 'main')!).id

function demoFacts(league: League, cast: PersonaRow[], extra: Partial<DemoFacts>): DemoFacts {
  return {
    fans: cast.filter((p) => p.kind === 'fan').map((p) => p.id),
    reporters: cast.filter((p) => p.kind === 'reporter').map((p) => p.id),
    boards: league.config.community.boards.filter((b) => b.role !== 'poten' && b.role !== 'notice').map((b) => b.id),
    headline: '',
    teams: [],
    names: [],
    postIds: [],
    ...extra,
  }
}

export const join2 = (...blocks: string[]) => blocks.filter(Boolean).join('\n\n')

// ── Inputs per job ───────────────────────────────────────────────────────

export function gameThreadInput(league: League, gameId: number, eventId: number): StoryInput {
  const game = getGame(league.db, gameId)
  const g = gameBlock(league, gameId)
  const teams = game ? [game.home, game.away] : []
  const cast = pickCast(league, { teams, fans: 18, reporters: 1, salt: `game:${gameId}:${eventId}` })
  return {
    ...aiFor(league.config, 'gameThread'),
    instructions: '',
    context: join2(boardsBlock(league), leagueBlock(league), g.text, loreFor(league, teams, g.players), myTakesBlock(league, teams, g.players), castBlock(league, cast), coveredBlock(league)),
    board: boardOf(league, 'games'),
    gameId,
    eventId,
    asOfEvent: lastEventId(league.db),
    spreadMs: 15 * 60_000,
    demo: demoFacts(league, cast, { headline: g.headline, teams: g.teams, names: g.players.map((p) => playerName(league, p)) }),
  }
}

/** One line per event, in Korean, plus who's involved. */
export function describeEvent(league: League, e: LeagueEvent): { text: string; teams: string[]; players: string[]; role: string } | null {
  const p = e.payload as Record<string, unknown>
  const awardName = (id: string) =>
    [...league.config.awards.season, ...league.config.awards.periodic].find((a) => a.id === id)?.name ?? id
  switch (e.type) {
    case 'trade_applied': {
      const players = (p.players as string[]) ?? []
      const moves = players.map((id) => `${playerName(league, id)} → ${short(league, league.players.get(id)?.teamId ?? '')}`)
      const cards = ((p.cards as number[]) ?? []).length
      const gm = p.negotiationId ? ` (단장 간 협상으로 성사${p.lopsided ? ', 한쪽으로 크게 기운 거래라 사기 트레이드 논란' : ''})` : ''
      return {
        text: `트레이드 성사: ${((p.teams as string[]) ?? []).map((t) => short(league, t)).join(' ↔ ')}${moves.length ? ` — ${moves.join(', ')}` : ''}${cards ? `, 카드 ${cards}장` : ''}${gm}`,
        teams: (p.teams as string[]) ?? [],
        players,
        role: 'trades',
      }
    }
    case 'award_given': {
      const id = p.playerId as string
      const period = (p.period as string) ? ` (${p.period as string})` : ''
      const rank = (p.teamRank as number) > 1 ? ` ${p.teamRank as number}팀` : ''
      return { text: `수상: ${awardName(p.awardId as string)}${rank}${period} — ${playerName(league, id)} (${short(league, league.players.get(id)?.teamId ?? '')})`, teams: [], players: [id], role: 'main' }
    }
    case 'game_corrected': {
      const game = getGame(league.db, p.gameId as number)
      const before = p.before as { homeScore: number; awayScore: number }
      const after = p.after as { homeScore: number; awayScore: number }
      if (!game) return null
      const same = before.homeScore === after.homeScore && before.awayScore === after.awayScore
      return {
        text: same
          ? `박스스코어 수정: ${short(league, game.home)} ${after.homeScore} : ${after.awayScore} ${short(league, game.away)} (점수는 그대로)`
          : `점수 정정: ${short(league, game.home)} ${before.homeScore} : ${before.awayScore} ${short(league, game.away)} → ${after.homeScore} : ${after.awayScore}`,
        teams: [game.home, game.away],
        players: [],
        role: 'games',
      }
    }
    case 'game_unrecorded': {
      const x = p as EventPayloads['game_unrecorded']
      return {
        text: `기록 취소: ${short(league, x.home)} ${x.homeScore} : ${x.awayScore} ${short(league, x.away)} 경기 결과가 취소됐다. 아직 치르지 않은 경기로 돌아갔고, 승패와 개인 기록도 빠졌다`,
        teams: [x.home, x.away],
        players: [],
        role: 'games',
      }
    }
    case 'series_won':
      return {
        text: `시리즈 종료: ${short(league, p.winner as string)}이(가) ${short(league, p.loser as string)}을(를) ${p.wins as number}-${p.losses as number}로 꺾음 (${p.slot as string})`,
        teams: [p.winner as string, p.loser as string],
        players: [],
        role: 'games',
      }
    case 'playoffs_seeded': {
      const seeds = p.seeds as Record<string, string[]>
      return {
        text: `플레이오프 대진 확정: ${Object.values(seeds)
          .map((list) => list.map((t, i) => `${i + 1}번 ${short(league, t)}`).join(', '))
          .join(' / ')}`,
        teams: Object.values(seeds).flat().slice(0, 8),
        players: [],
        role: 'main',
      }
    }
    case 'draft_protect':
      return { text: `드래프트: ${short(league, p.teamId as string)}이(가) ${playerName(league, p.playerId as string)} 보호`, teams: [p.teamId as string], players: [p.playerId as string], role: 'draft' }
    case 'draft_swap':
      return {
        text: `드래프트 스왑: ${short(league, p.teamId as string)}이(가) ${playerName(league, p.playerId as string)}을(를) 내주고 ${short(league, p.targetTeamId as string)}의 ${playerName(league, p.targetPlayerId as string)} 영입`,
        teams: [p.teamId as string, p.targetTeamId as string],
        players: [p.playerId as string, p.targetPlayerId as string],
        role: 'draft',
      }
    case 'draft_pass':
      return { text: `드래프트: ${short(league, p.teamId as string)} 패스`, teams: [p.teamId as string], players: [], role: 'draft' }
    case 'season_started': {
      const { schedule } = league.config.season
      const build = schedule.kind === 'round-robin' ? schedule.build : 'auto'
      return {
        text: `${league.config.league.name} 개막! 정규시즌 ${p.games as number}경기${
          build === 'played' ? ' (2K 일정대로: 대진은 경기하는 날 정해진다)' : build === 'manual' ? ' (대진은 라운드마다 발표)' : ' 일정 확정'
        }`,
        teams: [],
        players: [],
        role: 'main',
      }
    }
    case 'mood_changed': {
      const id = p.playerId as string
      const why = ((p.reasons as string[]) ?? []).map((r) => MOOD_PART_KO[r] ?? r).join(', ')
      return {
        text: `선수 분위기(소문으로만 다룰 것): ${playerName(league, id)}(${short(league, p.teamId as string)}) ${MOOD_BAND_KO[p.from as string] ?? p.from} → ${MOOD_BAND_KO[p.to as string] ?? p.to}${why ? ` · 이유로 보이는 것: ${why}` : ''}`,
        teams: [p.teamId as string],
        players: [id],
        role: 'trades',
      }
    }
    case 'standings_moment': {
      const m = p as EventPayloads['standings_moment']
      const team = short(league, m.teamId)
      const line = standings(league.db).overall.find((s) => s.teamId === m.teamId)
      const record = line ? ` (${line.wins}승 ${line.losses}패)` : ''
      const where = (league.config.season.playoffs.bracket === 'conference' && conferenceName(league, m.teamId)) || '리그'
      const text =
        m.kind === 'clinch'
          ? m.place === 'top'
            ? `${team}, ${where} 1위${league.config.season.playoffs.enabled ? '(1번 시드)' : ''} 확정${record}`
            : m.place === 'direct'
              ? `${team}, 플레이오프 직행 확정${record}`
              : `${team}, 최소 플레이-인 진출 확정${record}`
          : m.kind === 'eliminated'
            ? `${team}, 플레이오프 탈락 확정${record}`
            : m.kind === 'leader'
              ? `${team}, 전체 1위 등극${m.previous ? ` (${short(league, m.previous)}을(를) 끌어내림)` : ''}${record}`
              : m.kind === 'streak'
                ? `${team}, ${m.length}${m.won ? '연승 행진' : '연패 수렁'}${record}`
                : `${team}, ${m.length}${m.won ? '연승 마감' : '연패 탈출'}${record}`
      return { text: `순위 소식: ${text}`, teams: [m.teamId], players: [], role: 'main' }
    }
    case 'wanting_out': {
      const id = p.playerId as string
      return {
        text: `선수 분위기(소문으로만 다룰 것): ${playerName(league, id)}(${short(league, p.teamId as string)})가 학교를 떠나고 싶어 한다는 이야기가 돈다`,
        teams: [p.teamId as string],
        players: [id],
        role: 'trades',
      }
    }
    case 'player_said': {
      const id = p.playerId as string
      const target = p.targetId ? playerName(league, p.targetId as string) : null
      const act: Record<string, string> = {
        public_complaint: ' · 공개적으로 불만을 드러냄',
        public_request: ' · 공개 트레이드 요청',
        praise_teammate: target ? ` · ${target} 칭찬` : '',
        call_out_rival: target ? ` · ${target} 저격` : '',
      }
      const where = p.channel === 'sns' ? 'SNS에 올린 글' : '인터뷰'
      // Numbers marked on his words are shown as unverified (writers may still quote him: see `marked`).
      const words = (p.quote as string) ? ` ${where}: ${tagUnverified(said(p.quote as string, 300), flagsOf(league.db, 'player_quote', p.quoteId as number))}` : ''
      return {
        text: `${playerName(league, id)}(${short(league, p.teamId as string)})${words}${act[p.action as string] ?? ''}`,
        teams: [p.teamId as string],
        players: [id, ...(p.targetId ? [p.targetId as string] : [])],
        role: p.action === 'public_request' ? 'trades' : 'main',
      }
    }
    case 'trade_talks': {
      const players = (p.players as string[]) ?? []
      return {
        text: `찌라시(확인 안 된 소문으로만 다룰 것): ${((p.teams as string[]) ?? []).map((t) => short(league, t)).join(' ↔ ')} 사이에 트레이드 협상이 있었으나 결렬됐다는 말${players.length ? ` — 거론된 선수: ${players.map((id) => playerName(league, id)).join(', ')}` : ''}`,
        teams: (p.teams as string[]) ?? [],
        players,
        role: 'trades',
      }
    }
    case 'trade_window_closed': {
      // A window where nobody even talked isn't news.
      const talks = p.talks as number
      const trades = p.trades as number
      const agreed = (p.agreed as number | undefined) ?? 0
      if (talks === 0) return null
      const collapsed = talks - trades - agreed
      return {
        text: `트레이드 창 마감: 성사 ${trades}건${agreed ? `, 커미셔너 승인 대기 ${agreed}건` : ''}${collapsed > 0 ? `, 결렬·무산 ${collapsed}건` : ''}`,
        teams: [],
        players: [],
        role: 'trades',
      }
    }
    case 'news_posted':
      return { text: `소식: ${said(p.text as string, 1000)}`, teams: (p.teams as string[]) ?? [], players: (p.players as string[]) ?? [], role: 'main' }
    case 'secret_revealed': {
      // Only what you approved as now known: the text that went to 공개 or 소문, or who the tie is with.
      const m = p as EventPayloads['secret_revealed']
      const who =
        m.target === 'player' && m.playerId ? `${playerName(league, m.playerId)}(${short(league, m.teamId)})` : m.target === 'gm' ? `${short(league, m.teamId)} 단장` : short(league, m.teamId)
      const what = m.relationship
        ? `${who}와(과) ${said(m.relationship.with, 40)}은(는) ${RELATION_KO[m.relationship.type] ?? m.relationship.type} 사이`
        : `${who} — ${said(m.text, 800)}`
      return {
        text: m.to === 'public' ? `감춰졌던 이야기가 밝혀짐(이제 알려진 사실): ${what}` : `찌라시(확인 안 된 소문으로만 다룰 것): ${what}라는 말이 돈다`,
        teams: [m.teamId],
        players: [m.playerId, m.relationship?.playerId].filter((id): id is string => Boolean(id)),
        role: 'main',
      }
    }
    default:
      return null
  }
}

export function eventThreadInput(league: League, events: LeagueEvent[]): StoryInput | null {
  const described = events.map((e) => describeEvent(league, e)).filter((d): d is NonNullable<typeof d> => d !== null)
  if (described.length === 0) return null
  const teams = [...new Set(described.flatMap((d) => d.teams))]
  const players = [...new Set(described.flatMap((d) => d.players))]
  const cast = pickCast(league, { teams, fans: 16, reporters: 2, salt: `event:${events.map((e) => e.id).join(',')}` })
  const news = `# 이번 소식\n${described.map((d) => `- ${d.text}`).join('\n')}`
  // A player's words with numbers marked (not in his facts): the forum's posts repeating them are marked too.
  const marked = [
    ...new Set(events.filter((e) => e.type === 'player_said').flatMap((e) => flagsOf(league.db, 'player_quote', (e.payload as EventPayloads['player_said']).quoteId))),
  ]
  return {
    ...aiFor(league.config, 'article'),
    ...(marked.length ? { marked } : {}),
    instructions: events.every((e) => e.type === 'standings_moment') ? STANDINGS_NOTE : '',
    context: join2(boardsBlock(league), leagueBlock(league), news, loreFor(league, teams, players), myTakesBlock(league, teams, players), castBlock(league, cast), coveredBlock(league)),
    board: boardOf(league, described[0]!.role),
    eventId: events.at(-1)!.id,
    asOfEvent: lastEventId(league.db),
    spreadMs: 12 * 60_000,
    demo: demoFacts(league, cast, {
      headline: described.length === 1 ? described[0]!.text : `${described[0]!.text} 외 ${described.length - 1}건`,
      teams: teams.map((t) => short(league, t)),
      names: players.map((p) => playerName(league, p)),
    }),
  }
}

/** What a thread about standings moments alone is told: mostly the fans, an article only for settled places. */
export const STANDINGS_NOTE =
  '이번 소식은 순위 소식뿐이다(확정, 탈락, 1위 교체, 연승·연패). 기자 기사는 확정이나 탈락이 있을 때만 짧게 1개 쓴다. 팬 반응 스레드 1개: 그 학교 팬의 환호나 자조, 라이벌 팬의 조롱, "아직 모른다"는 반론을 섞는다. 확정과 탈락은 자료에 적힌 것만 쓰고, 남은 경기 수나 경우의 수를 지어내지 않는다.'

/** What a draft's live thread is told when it opens. */
export const LIVE_DRAFT_START =
  '드래프트가 시작됐다. "이번 소식"을 담아 "드래프트 라이브" 스레드 1개만 쓴다(제목에 드래프트 라이브, 말머리 라이브, 본문은 지금까지의 보호와 지명 정리, 댓글 10~16개). 앞으로 지명이 나올 때마다 이 스레드에 댓글이 이어진다. 기사는 쓰지 않는다. replies는 빈 배열.'

/**
 * New draft moves as comments on the draft's live thread: the moves, the
 * thread and its latest comments, and a cast leaning to the schools involved.
 * `postId` is null while the thread is still being written (the job then
 * finds it under `liveKey` when it runs).
 */
export function liveCommentsInput(league: League, events: LeagueEvent[], postId: number | null, liveKey: string): StoryInput | null {
  const described = events.map((e) => describeEvent(league, e)).filter((d): d is NonNullable<typeof d> => d !== null)
  if (described.length === 0) return null
  const teams = [...new Set(described.flatMap((d) => d.teams))]
  const players = [...new Set(described.flatMap((d) => d.players))]
  const cast = pickCast(league, { teams, fans: 14, reporters: 0, salt: `live:${events.map((e) => e.id).join(',')}` })
  const recent =
    postId === null
      ? []
      : (league.db
          .prepare('SELECT c.id, c.body, a.nick FROM comments c JOIN personas a ON a.id = c.author_id WHERE c.post_id = ? ORDER BY c.id DESC LIMIT 10')
          .all(postId) as { id: number; body: string; nick: string }[])
  const tag = unverified(league.db, 'comment', recent.map((c) => c.id))
  const thread = [
    `# 드래프트 라이브 스레드 (글 ${postId ?? '?'})`,
    recent.length ? `최근 댓글:\n${[...recent].reverse().map((c) => `${said(c.nick, 20)}: ${tag(c.id, said(c.body, 200))}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...aiFor(league.config, 'live'),
    instructions: `라이브 스레드 글 번호: ${postId ?? '(곧 올라올 글, postId에는 0)'}.`,
    context: join2(leagueBlock(league), `# 이번 소식 (드래프트 진행)\n${described.map((d) => `- ${d.text}`).join('\n')}`, thread, loreFor(league, teams, players), castBlock(league, cast)),
    board: boardOf(league, 'draft'),
    postId,
    liveKey,
    asOfEvent: lastEventId(league.db),
    spreadMs: 8 * 60_000,
    demo: demoFacts(league, cast, { headline: described[0]!.text, teams: teams.map((t) => short(league, t)), names: players.map((p) => playerName(league, p)) }),
  }
}

/**
 * The round-up when a regular-season round is complete: every result, the round's best lines, the table.
 * In 2K 일정대로 it's a session's (N일차): schools played different numbers of games in it, some none.
 */
export function roundUpInput(league: League, seasonId: number, round: number): StoryInput | null {
  const games = listGames(league.db, seasonId).filter((g) => g.stage === 'regular' && g.round === round)
  if (!roundComplete(league.db, seasonId, round)) return null
  const played = playedMode(league.config)
  const label = roundLabel(league.config, round)
  const results = games.map((g) => `${short(league, g.home)} ${g.homeScore} : ${g.awayScore} ${short(league, g.away)}`)
  const lines = games.flatMap((g) => boxLines(league.db, g.id))
  const best = lines.sort((a, b) => (b.stats.pts ?? 0) - (a.stats.pts ?? 0)).slice(0, 5)
  const view = standings(league.db)
  const leaders = view.overall.slice(0, 2).map((s) => s.teamId)
  const cast = pickCast(league, { teams: leaders, fans: 16, reporters: 2, salt: `round:${seasonId}:${round}` })
  // Who played how often in this session (a school can play twice, or rest).
  const perSchool = new Map<string, number>()
  for (const g of games) for (const t of [g.home, g.away]) perSchool.set(t, (perSchool.get(t) ?? 0) + 1)
  const news = [
    `# 이번 소식`,
    played
      ? `- ${label} 경기가 모두 끝났다(${games.length}경기). 2K 일정대로라 일차마다 뛰는 학교가 다르다: 이번에 쉰 학교도 있고 두 경기 넘게 한 학교도 있다. 일차 정리 기사(말머리 일차 정리)와 반응 스레드를 쓴다.`
      : `- R${round} 일정이 모두 끝났다. 라운드 정리 기사(말머리 라운드 정리)와 반응 스레드를 쓴다.`,
    `# ${label} 결과`,
    ...results.map((r) => `- ${r}`),
    played ? `# ${label}에 뛴 학교 (나머지는 쉼)\n${[...perSchool].map(([t, n]) => `${short(league, t)} ${n}경기`).join(', ')}` : '',
    best.length ? `# ${label} 활약\n${best.map((l) => `- ${playerName(league, l.playerId)} (${short(league, l.teamId)}) ${statLine(l.stats)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...aiFor(league.config, 'article'),
    instructions: played ? `${label} 정리다.` : `R${round} 라운드 정리다.`,
    context: join2(
      boardsBlock(league),
      leagueBlock(league),
      news,
      loreFor(league, leaders, best.map((l) => l.playerId)),
      myTakesBlock(league, leaders, best.map((l) => l.playerId)),
      castBlock(league, cast),
      coveredBlock(league),
    ),
    board: boardOf(league, 'main'),
    asOfEvent: lastEventId(league.db),
    spreadMs: 12 * 60_000,
    demo: demoFacts(league, cast, {
      headline: played ? `${label} 정리` : `R${round} 라운드 정리`,
      teams: leaders.map((t) => short(league, t)),
      names: best.map((l) => playerName(league, l.playerId)),
    }),
  }
}

/** How many of your past takes a writer sees. */
const MY_TAKES = 4

/**
 * Your own past posts and comments, so fans can bring them back up: a call
 * that came true (성지) or didn't (박제). Takes about this story's schools
 * and players come first, then the latest; a few words like "ㅋㅋ" aren't
 * takes. `except` leaves out what this job is itself answering. Each take
 * says roughly when it was made (the round played by then).
 */
export function myTakesBlock(league: League, teams: readonly string[], players: readonly string[], except: { postId?: number; commentId?: number } = {}): string {
  const rows = league.db
    .prepare(
      `SELECT 'post' AS kind, id, title, title || ' ' || body AS text, shown_at FROM posts WHERE author_id = 'me' AND kind IN ('user', 'live')
       UNION ALL
       SELECT 'comment', c.id, p.title, c.body, c.shown_at FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.author_id = 'me'
       ORDER BY shown_at DESC LIMIT 500`,
    )
    .all() as { kind: 'post' | 'comment'; id: number; title: string; text: string; shown_at: string }[]
  const takes = rows.filter(
    (r) =>
      r.text.replace(/[\sㄱ-ㅎㅏ-ㅣ!?.~^]/g, '').length >= 4 &&
      !(r.kind === 'post' && r.id === except.postId) &&
      !(r.kind === 'comment' && r.id === except.commentId),
  )
  if (takes.length === 0) return ''
  // Each take is matched against names once.
  const isAbout = new Map(
    takes.map((r) => {
      const m = mentions(league, r.text)
      return [r, m.teams.some((t) => teams.includes(t)) || m.players.some((p) => players.includes(p))] as const
    }),
  )
  const picked = [...takes.filter((r) => isAbout.get(r)), ...takes.filter((r) => !isAbout.get(r))].slice(0, MY_TAKES)
  const season = currentSeason(league.db)
  // The season a take was made in is the newest one begun by then; the round, the last played in it by then.
  const when = (at: string) => {
    const s = league.db.prepare('SELECT id, label FROM seasons WHERE started_at <= ? ORDER BY id DESC LIMIT 1').get(at) as { id: number; label: string } | undefined
    if (!s) return '개막 전'
    const r = league.db
      .prepare("SELECT MAX(round) AS round FROM games WHERE season_id = ? AND stage = 'regular' AND status = 'final' AND recorded_at <= ?")
      .get(s.id, at) as { round: number | null }
    const label = s.id === season.id ? '' : `${said(s.label, 30)} `
    return r.round === null ? `${label}개막 전` : `${label}${roundLabel(league.config, r.round)} 무렵`
  }
  const lines = picked.map((r) => `- ${when(r.shown_at)} · ${r.kind === 'post' ? '내 글' : `${said(r.title, 60)} 글에 단 댓글`}: ${said(r.text, 200)}`)
  return `# 내가 전에 한 말 (나 = 이 게시판을 보는 사용자. 맞았으면 "성지"로 추켜세우고, 틀렸으면 "박제"로 꺼내 놀릴 수 있다. 어울릴 때만, 한 글에 한두 번)\n${lines.join('\n')}`
}

/** Mentions of teams and players in free text (for news, your posts and poll options). */
export function mentions(league: Pick<League, 'teams' | 'players'>, text: string): { teams: string[]; players: string[] } {
  return {
    teams: [...league.teams.values()].filter((t) => text.includes(t.shortName)).map((t) => t.id),
    players: [...league.players.values()].filter((p) => p.name.length >= 2 && text.includes(p.name)).map((p) => p.id),
  }
}

export function replyInput(league: League, postId: number, commentId: number | null): StoryInput {
  const post = league.db.prepare('SELECT id, title, body, kind, game_id FROM posts WHERE id = ?').get(postId) as
    | { id: number; title: string; body: string; kind: string; game_id: number | null }
    | undefined
  const recent = league.db
    .prepare(
      `SELECT c.id, c.body, c.author_id, a.nick FROM comments c JOIN personas a ON a.id = c.author_id
       WHERE c.post_id = ? AND c.shown_at <= ? ORDER BY c.shown_at DESC, c.id DESC LIMIT 15`,
    )
    .all(postId, new Date().toISOString()) as { id: number; body: string; author_id: string; nick: string }[]
  const mine = commentId !== null ? recent.find((c) => c.id === commentId) : undefined
  const userText = mine?.body ?? `${post?.title ?? ''}\n${post?.body ?? ''}`
  // A poll on the post: repliers can say which they'd pick.
  const poll = pollView(league.db, postId, Date.now())
  const pollText = poll ? `${poll.question} ${poll.options.map((o) => o.text).join(' ')}` : ''
  const m = mentions(league, `${post?.title ?? ''} ${post?.body ?? ''} ${mine?.body ?? ''} ${pollText}`)
  const game = post?.game_id ? gameBlock(league, post.game_id) : null
  const cast = pickCast(league, { teams: m.teams, fans: 8, reporters: 0, salt: `reply:${postId}:${commentId}` })
  const postTag = unverified(league.db, 'post', [postId])
  const tag = unverified(league.db, 'comment', recent.map((c) => c.id))
  const thread = [
    `# 글 ${postId}${post?.kind === 'live' ? ' (라이브 경기 스레드)' : ''}`,
    `제목: ${postTag(postId, said(post?.title ?? '', 120))}`,
    post?.body ? `본문: ${postTag(postId, said(post.body, 1500))}` : '',
    poll ? `투표: ${said(poll.question, 80)} 보기: ${poll.options.map((o, i) => `${i + 1}번 ${said(o.text, 40)}`).join(' / ')}` : '',
    recent.length
      ? `# 최근 댓글 (오래된 순)\n${[...recent]
          .reverse()
          .map((c) => `[${c.id}] ${c.author_id === 'me' ? '나' : said(c.nick, 20)}: ${tag(c.id, said(c.body, 400))}`)
          .join('\n')}`
      : '',
    `# 내 글/댓글\n${commentId !== null ? `댓글 ${commentId}: ${said(mine?.body ?? '', 600)}` : `글 ${postId} 자체`}`,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...aiFor(league.config, 'reply'),
    instructions: `글 번호는 ${postId}${commentId !== null ? `, 답할 내 댓글 번호는 ${commentId}` : ''}.`,
    context: join2(
      leagueBlock(league),
      game?.text ?? '',
      thread,
      loreFor(league, m.teams, m.players),
      myTakesBlock(league, m.teams, m.players, commentId !== null ? { commentId } : { postId }),
      castBlock(league, cast),
    ),
    board: boardOf(league, 'free'),
    postId,
    commentId,
    asOfEvent: lastEventId(league.db),
    spreadMs: 90_000,
    demo: demoFacts(league, cast, { userText, teams: m.teams.map((t) => short(league, t)), names: m.players.map((p) => playerName(league, p)) }),
  }
}

export function chatterInput(league: League): StoryInput {
  const seed = hash32(`chatter:${lastEventId(league.db)}:${Date.now()}`)
  const random = rng(seed)
  const c = league.config.community
  // About one new post per four items; the rest are their comments and replies to hot threads.
  const seeds = planTopics(league, Math.max(4, Math.min(10, Math.round(c.chatterBatch / 4))), seed)
  const teams = [...new Set(seeds.flatMap((s) => s.teams).filter(Boolean))]
  const players = [...new Set(seeds.flatMap((s) => s.players))]
  const hot = hotPosts(league, 8)
  const hotTitle = unverified(league.db, 'post', hot.map((h) => h.id))
  const cast = pickCast(league, { teams, fans: 30, reporters: 1, salt: `chatter:${random()}` })
  const plan = [
    `# 이번에 쓸 글 (하나에 새 글 하나, 적힌 게시판과 말머리로)`,
    ...seeds.map((s, i) => {
      const head = `${i + 1}. [${TOPIC_LABEL[s.kind]} · 게시판 ${boardOf(league, s.board)}${s.tag ? ` · 말머리 ${s.tag}` : ''}] ${s.brief}`
      return s.facts.length ? `${head}\n   자료: ${s.facts.join(' / ')}` : head
    }),
    hot.length ? `# 지금 뜨는 글 (replies의 postId로 쓸 수 있음)\n${hot.map((h) => `[${h.id}] ${hotTitle(h.id, said(h.title, 100))} (댓글 ${h.comments})`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  // World topics in the plan bring their own lore (공개 and 소문, never 비밀).
  const worldLore = seeds
    .filter((s) => s.kind === 'world_topic')
    .map((s) => league.lore.world.find((w) => w.kind === 'world' && s.facts[0] === `주제: ${w.settings.id}`))
    .map((w) => (w ? loreBlock(w, w.settings.id, 'rumor') : ''))
    .filter(Boolean)
    .join('\n\n')
  // The demo writer turns the plan's poll topic into a post with a poll.
  const poll = seeds.find((s) => s.poll)?.poll
  return {
    ...aiFor(league.config, 'chatter'),
    instructions: `위 "이번에 쓸 글" ${seeds.length}개를 하나씩 새 글로 쓰고(글마다 댓글 3~8개), "지금 뜨는 글"에 댓글 묶음 3~6개를 단다. 모두 합쳐 ${c.chatterBatch}개 안팎.`,
    context: join2(boardsBlock(league), leagueBlock(league), plan, loreFor(league, teams, players), worldLore, myTakesBlock(league, teams, players), castBlock(league, cast), coveredBlock(league)),
    board: boardOf(league, 'free'),
    asOfEvent: lastEventId(league.db),
    spreadMs: 6 * 60_000,
    demo: demoFacts(league, cast, {
      headline: `chatter-${lastEventId(league.db)}-${hot.length}`,
      teams: teams.map((t) => short(league, t)),
      names: players.map((p) => playerName(league, p)),
      postIds: hot.map((h) => h.id),
      ...(poll ? { poll } : {}),
    }),
  }
}

/** How each topic is named to the writers. */
const TOPIC_LABEL: Record<TopicKind, string> = {
  lore_story: '선수·학교 이야기',
  rumor: '찌라시',
  world_topic: '세계관 이야기',
  rivalry: '라이벌 학교 키배',
  league_roast: '리그 까기',
  rankings: '티어표·순위 논쟁',
  stats: '기록 분석',
  prediction: '예언·박제',
  meme: '드립·짤',
  off_topic: '일상 잡담',
  newbie: '뉴비 질문',
  drama: '분위기 수상',
  school_pride: '학교 부심',
  poll: '투표',
  game_talk: '지난 경기',
}

export type { StoryKind }

const MOOD_PART_KO: Record<string, string> = {
  role: '출전 역할',
  usage: '슛 기회',
  production: '개인 기록',
  winning: '팀 성적',
  recognition: '인정받지 못함',
  relationships: '동료 관계',
  rivalry: '라이벌',
  stability: '이적·불안',
  belonging: '소속감',
}
const MOOD_BAND_KO: Record<string, string> = { happy: '행복', content: '만족', neutral: '보통', unhappy: '불만', boiling: '폭발 직전' }
/** Relationship kinds as writers read them. */
export const RELATION_KO: Record<string, string> = { friend: '친구', rival: '라이벌', family: '가족', mentor: '멘토', dislikes: '앙숙' }
