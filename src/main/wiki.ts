import type { LeagueConfig, WikiConfig } from '@shared/config/schema'
import type { EventPayloads } from '@shared/events'
import { parseWiki } from '@shared/namumark'
import { rotationMove } from '@shared/roster'
import type {
  HistoryItem,
  Infobox,
  WikiData,
  WikiDiffView,
  WikiPageTalk,
  WikiPageView,
  WikiRevisionView,
  WikiSaveInput,
  WikiSearchResult,
  WikiTable,
  WikiThreadInput,
  WikiThreadSummary,
  WikiThreadView,
} from '@shared/wiki'
import { setStoryValue, storyValue } from '@data/community'
import { jsonField, transaction, type Db } from '@data/db'
import { currentSeason, listEvents, listPlayers, listTeams, loadConfig, updateConfig } from '@data/league'
import { addTalk, closeThread, commentCount, getThread, openDisputes, openThread, openThreadCount, recentThreads, reopenThread, talkLines, threadsOfPage, threadSummary } from '@data/talk'
import { listAwards } from '@data/moves'
import { standings } from '@data/season'
import {
  authorOf,
  backlinkCount,
  backlinks,
  existingTitles,
  pageByTitle,
  pageCount,
  pageFlags,
  pageHistory,
  randomTitle,
  recentChanges,
  revisionBody,
  revisionView,
  saveRevision,
  searchWiki,
  titlesByRef,
  type PageRow,
} from '@data/wiki'
import { diffText } from '@shared/diff'
import { playedMode, roundLabel } from '@shared/played'
import { refuse } from '@data/rules'
import { readLeague } from '@story/context'
import { seedWiki, syncSchoolCategories, wikiTitles, type WikiTitles } from '@story/wiki'
import { WIKI_TALK_KINDS } from '@story/wikiTalk'
import type { PlayerRow } from '@shared/league'
import type { Team } from '@shared/setup'

const SEEDED = 'wiki-seeded-at'

interface Ctx {
  config: LeagueConfig
  teams: Team[]
  players: PlayerRow[]
  titles: WikiTitles
  seasonLabels: Map<number, string>
  currentSeason: number
}

const STAGES: Record<string, string> = { regular: '정규', 'play-in': '플레이-인', playoffs: '플레이오프', finals: '파이널' }

/** 'w3' → '3주차', 'm2' → '2개월차', '' → ''. */
function periodLabel(period: string): string {
  const m = period.match(/^([wm])(\d+)$/)
  if (!m) return period
  return m[1] === 'w' ? `${m[2]}주차` : `${m[2]}개월차`
}

const pct = (w: number, l: number) => (w + l === 0 ? '-' : (w / (w + l)).toFixed(3).replace(/^0/, ''))

/** Where a change of yours came from, so the story engine can answer it (left out in tests and scripts). */
export interface WikiAt {
  slug: string
  folder: string
}

/** What your wiki actions set off: editors answering in 토론, or pushing back on a change to their text. */
export interface WikiHooks {
  talk?: (slug: string, db: Db, folder: string, threadId: number) => void
  saved?: (slug: string, db: Db, folder: string, pageId: number, rev: number) => void
}

/** The wiki for the open league: pages, revisions, 토론 and the live data behind infoboxes and macros. */
export class WikiService {
  constructor(private readonly hooks: WikiHooks = {}) {}

  /** Runs a hook without letting its failure undo what you just saved. */
  private after(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      console.warn('[wiki] reacting to your change failed', e)
    }
  }

  /** Seeds missing pages (new players, a new season) at most once a minute. */
  ensure(db: Db, folder: string, force = false): void {
    const last = storyValue(db, SEEDED)
    if (!force && pageCount(db) > 0 && last !== null && Date.now() - Date.parse(last) < 60_000) return
    const league = readLeague(db, folder)
    seedWiki(db, league.config, league.lore, Date.now())
    setStoryValue(db, SEEDED, new Date().toISOString())
  }

  private ctx(db: Db): Ctx {
    const { config } = loadConfig(db)
    const teams = listTeams(db)
    const players = listPlayers(db)
    const season = currentSeason(db)
    const labels = db.prepare('SELECT id, label FROM seasons ORDER BY id').all() as { id: number; label: string }[]
    // Existing pages keep their titles (a traded twin's page doesn't change name); computed titles fill the gaps.
    const computed = wikiTitles(config, season.label, teams, players)
    const titles: WikiTitles = {
      ...computed,
      player: new Map([...computed.player, ...titlesByRef(db, 'player')]),
      team: new Map([...computed.team, ...titlesByRef(db, 'team')]),
    }
    return { config, teams, players, titles, seasonLabels: new Map(labels.map((s) => [s.id, s.label])), currentSeason: season.id }
  }

  home(db: Db, folder: string): string {
    this.ensure(db, folder)
    return wikiTitles(loadConfig(db).config, currentSeason(db).label, [], []).league
  }

  page(db: Db, folder: string, title: string, rev?: number): WikiPageView {
    this.ensure(db, folder)
    const found = pageByTitle(db, title)
    // A moved player's page that missed its refiling (a move from before it existed) catches up when opened.
    if (found?.kind === 'player' && found.refId && rev === undefined) syncSchoolCategories(db, loadConfig(db).config, Date.now(), [found.refId])
    const page = pageByTitle(db, title)
    const empty: WikiData = { infobox: null, record: null, history: [], roster: null, recent: null }
    if (!page || page.currentRev === null) {
      const talk: WikiPageTalk = { open: 0, disputes: [] }
      return {
        title: title.trim(),
        exists: false,
        kind: null,
        rev: null,
        latestRev: null,
        source: '',
        updatedAt: null,
        author: null,
        existing: [],
        backlinks: backlinkCount(db, title.trim()),
        data: empty,
        talk,
        flags: [],
      }
    }
    const shown = rev !== undefined && rev >= 1 && rev <= page.currentRev ? rev : page.currentRev
    const body = revisionBody(db, page.id, shown)!
    const links = parseWiki(body.body).links
    return {
      title: page.title,
      exists: true,
      kind: page.kind,
      rev: shown,
      latestRev: page.currentRev,
      source: body.body,
      updatedAt: body.createdAt,
      author: authorOf(db, body.authorId),
      existing: existingTitles(db, links),
      backlinks: backlinkCount(db, page.title),
      data: this.data(db, page),
      talk: { open: openThreadCount(db, page.id), disputes: openDisputes(db, page.id).map((d) => ({ threadId: d.threadId, section: d.section, topic: d.topic, origin: d.origin === 'pushback' ? ('pushback' as const) : ('war' as const) })) },
      // Numbers an AI editor wrote that the facts didn't hold, in this revision or still in its text from an
      // earlier one: a notice on the page, for you only.
      flags: pageFlags(db, page.id, shown, body.body),
    }
  }

  /**
   * Saves your edit; returns the revision and the title as stored (a new
   * page's title is cleaned up). An editor whose text it changed may push back.
   */
  save(db: Db, input: WikiSaveInput, at?: WikiAt): { rev: number; title: string } {
    const page = pageByTitle(db, input.title)
    if (input.baseRev === null && page) refuse('wiki-conflict', { title: page.title })
    const { pageId, rev } = saveRevision(
      db,
      { title: input.title, body: input.source, authorId: 'me', summary: input.summary, ...(page ? { baseRev: input.baseRev } : {}) },
      Date.now(),
    )
    const title = (db.prepare('SELECT title FROM wiki_pages WHERE id = ?').get(pageId) as { title: string }).title
    // An unchanged save keeps the old revision: nothing new to answer.
    if (at && page && rev !== page.currentRev) this.after(() => this.hooks.saved?.(at.slug, db, at.folder, pageId, rev))
    return { rev, title }
  }

  // ── 토론 ───────────────────────────────────────────────────────────────

  threads(db: Db, title: string): WikiThreadSummary[] {
    const page = pageByTitle(db, title)
    if (!page) refuse('wiki-no-page', { title })
    return threadsOfPage(db, page.id)
  }

  /** One thread with its lines, and whether editors are writing to it. */
  thread(db: Db, id: number): WikiThreadView {
    const t = getThread(db, id)
    const kinds = WIKI_TALK_KINDS.map(() => '?').join(',')
    const replying = Boolean(
      db.prepare(`SELECT 1 FROM jobs WHERE kind IN (${kinds}) AND status IN ('queued', 'running') AND ${jsonField('input', '$.threadId')} = ? LIMIT 1`).get(...WIKI_TALK_KINDS, id),
    )
    return { ...threadSummary(db, id)!, lines: talkLines(db, id), closeNote: t.closeNote, replying }
  }

  /** 최근 토론. */
  recentThreads(db: Db): WikiThreadSummary[] {
    return recentThreads(db)
  }

  /** Opens a thread of yours on a page, your words as #1; editors answer. */
  openThread(db: Db, input: WikiThreadInput, at?: WikiAt): { id: number } {
    const page = pageByTitle(db, input.title)
    if (!page || page.currentRev === null) refuse('wiki-no-page', { title: input.title })
    if (!input.body.trim()) refuse('empty-post')
    const now = new Date().toISOString()
    const id = transaction(db, () => {
      const id = openThread(db, { pageId: page.id, topic: input.topic, origin: 'user', openedBy: 'me' }, now)
      addTalk(db, id, { authorId: 'me', body: input.body }, now)
      return id
    })
    if (at) this.after(() => this.hooks.talk?.(at.slug, db, at.folder, id))
    return { id }
  }

  /** Your comment in an open thread; editors answer. */
  comment(db: Db, threadId: number, body: string, at?: WikiAt): { n: number } {
    if (getThread(db, threadId).status !== 'open') refuse('wiki-thread-closed')
    addTalk(db, threadId, { authorId: 'me', body }, new Date().toISOString())
    if (at) this.after(() => this.hooks.talk?.(at.slug, db, at.folder, threadId))
    return { n: commentCount(db, threadId) }
  }

  /** Closes or reopens a thread (as the wiki's owner). Closing a dispute frees its section. */
  setThread(db: Db, threadId: number, open: boolean, note = ''): void {
    const now = new Date().toISOString()
    if (open) reopenThread(db, threadId, 'me', now)
    else closeThread(db, threadId, 'me', note, now)
  }

  saveSettings(db: Db, wiki: WikiConfig): number {
    const { config } = loadConfig(db)
    return updateConfig(db, { ...config, wiki })
  }

  history(db: Db, title: string): WikiRevisionView[] {
    const page = pageByTitle(db, title)
    if (!page) refuse('wiki-no-page', { title })
    return pageHistory(db, page.id)
  }

  /** 비교: two revisions of a page (either order), older first. */
  diff(db: Db, title: string, from: number, to: number): WikiDiffView {
    const page = pageByTitle(db, title)
    if (!page || page.currentRev === null) refuse('wiki-no-page', { title })
    const latest = page.currentRev
    const clamp = (r: number) => Math.min(Math.max(1, Math.floor(r)), latest)
    const [a, b] = [clamp(from), clamp(to)].sort((x, y) => x - y) as [number, number]
    return {
      title: page.title,
      from: revisionView(db, page.id, a)!,
      to: revisionView(db, page.id, b)!,
      latestRev: latest,
      diff: diffText(revisionBody(db, page.id, a)!.body, revisionBody(db, page.id, b)!.body),
    }
  }

  recent(db: Db): WikiRevisionView[] {
    return recentChanges(db)
  }

  backlinks(db: Db, title: string): string[] {
    return backlinks(db, title)
  }

  search(db: Db, query: string): WikiSearchResult[] {
    return searchWiki(db, query)
  }

  random(db: Db, folder: string): string | null {
    this.ensure(db, folder)
    return randomTitle(db)
  }

  // ── Live data ──────────────────────────────────────────────────────────

  private data(db: Db, page: PageRow): WikiData {
    const ctx = this.ctx(db)
    const none: WikiData = { infobox: null, record: null, history: [], roster: null, recent: null }
    switch (page.kind) {
      case 'player': {
        const p = ctx.players.find((x) => x.id === page.refId)
        return p ? { ...none, infobox: this.playerBox(ctx, p), record: this.playerRecord(db, ctx, p), history: this.playerHistory(db, ctx, p) } : none
      }
      case 'team': {
        const t = ctx.teams.find((x) => x.id === page.refId)
        return t ? { ...none, infobox: this.teamBox(db, ctx, t), record: this.teamRecord(db, ctx, t), roster: this.roster(ctx, t), recent: this.recentGames(db, ctx, t) } : none
      }
      case 'season':
        return { ...none, record: Number(page.refId) === ctx.currentSeason ? this.standingsTable(db, ctx) : this.pastStandings(db, ctx, Number(page.refId)) }
      case 'awards':
        return { ...none, record: this.awardsTable(db, ctx) }
      default:
        return none
    }
  }

  private teamName = (ctx: Ctx, id: string) => ctx.teams.find((t) => t.id === id)?.shortName ?? id

  private playerBox(ctx: Ctx, p: PlayerRow): Infobox {
    const team = ctx.teams.find((t) => t.id === p.teamId)
    const slot = ctx.config.roster.slots.find((s) => s.id === p.slotId)?.name
    const rows: Infobox['rows'] = [{ label: '소속', value: team?.shortName ?? '', link: team ? (ctx.titles.team.get(team.id) ?? null) : null }]
    if (slot) rows.push({ label: '포지션', value: slot, link: null })
    if (p.height) rows.push({ label: '키', value: p.height, link: null })
    for (const c of ctx.config.ratings.columns) {
      const v = p.ratings[c.id]
      if (v !== null && v !== undefined && v !== '') rows.push({ label: c.name, value: String(v), link: null })
    }
    if (p.nicknames.length) rows.push({ label: '별명', value: p.nicknames.join(', '), link: null })
    return { title: p.name, subtitle: team?.name ?? null, colors: team?.colors ?? [], rows }
  }

  private statColumns(ctx: Ctx) {
    return ctx.config.stats.columns.filter((c) => c.leader)
  }

  private playerRecord(db: Db, ctx: Ctx, p: PlayerRow): WikiTable {
    const cols = this.statColumns(ctx)
    const lines = db
      .prepare('SELECT g.season_id, b.team_id, b.stats FROM box_lines b JOIN games g ON g.id = b.game_id WHERE b.player_id = ? ORDER BY g.season_id')
      .all(p.id) as { season_id: number; team_id: string; stats: string }[]
    const bySeason = new Map<number, { team: string; games: number; sums: number[] }>()
    for (const l of lines) {
      const s = bySeason.get(l.season_id) ?? { team: l.team_id, games: 0, sums: cols.map(() => 0) }
      const stats = JSON.parse(l.stats) as Record<string, number>
      s.games++
      s.team = l.team_id
      cols.forEach((c, i) => (s.sums[i]! += stats[c.id] ?? 0))
      bySeason.set(l.season_id, s)
    }
    return {
      columns: ['시즌', '소속', '경기', ...cols.map((c) => c.name)],
      linkColumn: 1,
      rows: [...bySeason].map(([sid, s]) => ({
        cells: [ctx.seasonLabels.get(sid) ?? String(sid), this.teamName(ctx, s.team), String(s.games), ...s.sums.map((v) => (v / s.games).toFixed(1))],
        link: ctx.titles.team.get(s.team) ?? null,
      })),
    }
  }

  /** A player's season: trades, draft moves, going between the starters and the bench, awards and big games, oldest first. */
  private playerHistory(db: Db, ctx: Ctx, p: PlayerRow): HistoryItem[] {
    const out: HistoryItem[] = []
    const season = (id: number | null) => (id === null ? '' : (ctx.seasonLabels.get(id) ?? ''))
    const awardName = (id: string) => [...ctx.config.awards.season, ...ctx.config.awards.periodic].find((a) => a.id === id)?.name ?? id
    for (const e of listEvents(db)) {
      const x = e.payload as Record<string, unknown>
      if (e.type === 'trade_applied' && (x.players as string[]).includes(p.id)) {
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `트레이드: ${(x.teams as string[]).map((t) => this.teamName(ctx, t)).join(' ↔ ')}` })
      } else if (e.type === 'award_given' && x.playerId === p.id) {
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `수상: ${awardName(x.awardId as string)}${x.period ? ` (${periodLabel(x.period as string)})` : ''}` })
      } else if (e.type === 'draft_protect' && x.playerId === p.id) {
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `드래프트: ${this.teamName(ctx, x.teamId as string)}의 보호 선수로 지정` })
      } else if (e.type === 'draft_swap' && (x.playerId === p.id || x.targetPlayerId === p.id)) {
        const to = x.playerId === p.id ? (x.targetTeamId as string) : (x.teamId as string)
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `드래프트 스왑으로 ${this.teamName(ctx, to)} 이적` })
      } else if (e.type === 'slots_changed') {
        // Only going between the starters and the bench: the position itself is in the infobox.
        const c = (x.changes as EventPayloads['slots_changed']['changes']).find((y) => y.playerId === p.id)
        const move = c ? rotationMove(ctx.config.roster, c.from, c.to) : null
        const slot = (id: string | null) => ctx.config.roster.slots.find((s) => s.id === id)?.name ?? '–'
        if (c && move) out.push({ at: e.createdAt, season: season(e.seasonId), text: `${move === 'up' ? '주전 발탁' : '벤치로 이동'} (${slot(c.from)} → ${slot(c.to)})` })
      }
    }
    const points = ctx.config.stats.columns.find((c) => c.meaning === 'points')?.id
    if (points) {
      const big = db
        .prepare(
          `SELECT g.season_id, g.recorded_at, g.home_id, g.away_id, g.home_score, g.away_score, b.team_id, json_extract(b.stats, '$.' || ?) AS pts
           FROM box_lines b JOIN games g ON g.id = b.game_id WHERE b.player_id = ? AND json_extract(b.stats, '$.' || ?) >= 30`,
        )
        .all(points, p.id, points) as { season_id: number; recorded_at: string | null; home_id: string; away_id: string; home_score: number; away_score: number; team_id: string; pts: number }[]
      for (const g of big) {
        const vs = g.team_id === g.home_id ? g.away_id : g.home_id
        out.push({ at: g.recorded_at ?? '', season: season(g.season_id), text: `${this.teamName(ctx, vs)}전 ${g.pts}점` })
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at))
  }

  private teamBox(db: Db, ctx: Ctx, t: Team): Infobox {
    const division = ctx.config.structure.divisions.find((d) => d.id === t.divisionId)
    const conference = ctx.config.structure.conferences.find((c) => c.id === division?.conferenceId)
    const view = standings(db)
    const rank = view.overall.findIndex((s) => s.teamId === t.id)
    const line = view.overall[rank]
    const rows: Infobox['rows'] = []
    if (conference) rows.push({ label: '컨퍼런스', value: conference.name, link: null })
    if (division) rows.push({ label: '디비전', value: division.name, link: null })
    if (line) rows.push({ label: '이번 시즌', value: `${line.wins}승 ${line.losses}패 (${rank + 1}위)`, link: ctx.titles.season })
    rows.push({ label: '선수', value: `${ctx.players.filter((p) => p.teamId === t.id).length}명`, link: null })
    return { title: t.shortName, subtitle: t.name === t.shortName ? null : t.name, colors: t.colors, rows }
  }

  private teamRecord(db: Db, ctx: Ctx, t: Team): WikiTable {
    const rows = db
      .prepare(
        `SELECT season_id,
           SUM(CASE WHEN (home_id = ? AND home_score > away_score) OR (away_id = ? AND away_score > home_score) THEN 1 ELSE 0 END) AS w,
           SUM(CASE WHEN (home_id = ? AND home_score < away_score) OR (away_id = ? AND away_score < home_score) THEN 1 ELSE 0 END) AS l
         FROM games WHERE status = 'final' AND stage = 'regular' AND (home_id = ? OR away_id = ?) GROUP BY season_id ORDER BY season_id`,
      )
      .all(t.id, t.id, t.id, t.id, t.id, t.id) as { season_id: number; w: number; l: number }[]
    return {
      columns: ['시즌', '승', '패', '승률'],
      linkColumn: 0,
      rows: rows.map((r) => ({ cells: [ctx.seasonLabels.get(r.season_id) ?? String(r.season_id), String(r.w), String(r.l), pct(r.w, r.l)], link: null })),
    }
  }

  private roster(ctx: Ctx, t: Team): WikiTable {
    const overall = ctx.config.ratings.overallColumnId
    const slotOrder = (id: string | null) => ctx.config.roster.slots.findIndex((s) => s.id === id)
    return {
      columns: ['이름', '포지션', ...(overall ? [ctx.config.ratings.columns.find((c) => c.id === overall)?.name ?? 'OVR'] : [])],
      linkColumn: 0,
      rows: ctx.players
        .filter((p) => p.teamId === t.id)
        .sort((a, b) => slotOrder(a.slotId) - slotOrder(b.slotId))
        .map((p) => ({
          cells: [p.name, ctx.config.roster.slots.find((s) => s.id === p.slotId)?.name ?? '', ...(overall ? [String(p.ratings[overall] ?? '')] : [])],
          link: ctx.titles.player.get(p.id) ?? null,
        })),
    }
  }

  private recentGames(db: Db, ctx: Ctx, t: Team): WikiTable {
    const games = db
      .prepare(
        "SELECT round, stage, home_id, away_id, home_score, away_score FROM games WHERE status = 'final' AND (home_id = ? OR away_id = ?) ORDER BY recorded_at DESC, id DESC LIMIT 5",
      )
      .all(t.id, t.id) as { round: number; stage: string; home_id: string; away_id: string; home_score: number; away_score: number }[]
    return {
      columns: ['경기', '상대', '결과'],
      linkColumn: 1,
      rows: games.map((g) => {
        const home = g.home_id === t.id
        const us = home ? g.home_score : g.away_score
        const them = home ? g.away_score : g.home_score
        const vs = home ? g.away_id : g.home_id
        return {
          cells: [g.stage === 'regular' ? roundLabel(ctx.config, g.round) : `${STAGES[g.stage] ?? g.stage} ${g.round}차전`, `${home ? 'vs' : '@'} ${this.teamName(ctx, vs)}`, `${us > them ? '승' : '패'} ${us}:${them}`],
          link: ctx.titles.team.get(vs) ?? null,
        }
      }),
    }
  }

  private standingsTable(db: Db, ctx: Ctx): WikiTable {
    const view = standings(db)
    // 2K 일정대로: schools have played different numbers of games, so each row says how many.
    const gp = playedMode(ctx.config)
    return {
      columns: ['순위', '팀', ...(gp ? ['경기'] : []), '승', '패', '승률', '게임차'],
      linkColumn: 1,
      rows: view.overall.map((s, i) => ({
        cells: [
          String(i + 1),
          this.teamName(ctx, s.teamId),
          ...(gp ? [String(s.wins + s.losses)] : []),
          String(s.wins),
          String(s.losses),
          pct(s.wins, s.losses),
          s.gamesBehind === 0 ? '-' : String(s.gamesBehind),
        ],
        link: ctx.titles.team.get(s.teamId) ?? null,
      })),
    }
  }

  /** A finished season's table: wins and losses from its regular-season games. */
  private pastStandings(db: Db, ctx: Ctx, seasonId: number): WikiTable {
    const rows = db
      .prepare(
        `SELECT t.id AS team,
           SUM(CASE WHEN (g.home_id = t.id AND g.home_score > g.away_score) OR (g.away_id = t.id AND g.away_score > g.home_score) THEN 1 ELSE 0 END) AS w,
           SUM(CASE WHEN (g.home_id = t.id AND g.home_score < g.away_score) OR (g.away_id = t.id AND g.away_score < g.home_score) THEN 1 ELSE 0 END) AS l
         FROM teams t JOIN games g ON (g.home_id = t.id OR g.away_id = t.id) AND g.season_id = ? AND g.stage = 'regular' AND g.status = 'final'
         GROUP BY t.id ORDER BY w DESC, l ASC, t.id`,
      )
      .all(seasonId) as { team: string; w: number; l: number }[]
    return {
      columns: ['순위', '팀', '승', '패', '승률', '게임차'],
      linkColumn: 1,
      rows: rows.map((r, i) => ({
        cells: [String(i + 1), this.teamName(ctx, r.team), String(r.w), String(r.l), pct(r.w, r.l), '-'],
        link: ctx.titles.team.get(r.team) ?? null,
      })),
    }
  }

  private awardsTable(db: Db, ctx: Ctx): WikiTable {
    const rows: WikiTable['rows'] = []
    for (const [sid, label] of ctx.seasonLabels) {
      for (const a of listAwards(db, sid)) {
        const award = [...ctx.config.awards.season, ...ctx.config.awards.periodic].find((x) => x.id === a.awardId)
        const player = ctx.players.find((p) => p.id === a.playerId)
        rows.push({
          cells: [label, `${award?.name ?? a.awardId}${a.teamRank > 1 ? ` ${a.teamRank}팀` : ''}`, periodLabel(a.period), player?.name ?? a.playerId],
          link: ctx.titles.player.get(a.playerId) ?? null,
        })
      }
    }
    return { columns: ['시즌', '상', '기간', '선수'], linkColumn: 3, rows }
  }
}
