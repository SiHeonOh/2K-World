import { awardTitle, periodLabel } from '@shared/awards'
import type { LeagueConfig, WikiConfig } from '@shared/config/schema'
import type { EventPayloads } from '@shared/events'
import { parseWiki } from '@shared/namumark'
import { rotationMove } from '@shared/roster'
import type {
  CellTone,
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
  WikiRelation,
} from '@shared/wiki'
import { leagueChampion, seriesTitle } from '@shared/season'
import { leaders, seasonTotals } from '@core/stats'
import { setStoryValue, storyValue } from '@data/community'
import { jsonField, transaction, type Db } from '@data/db'
import { currentSeason, listEvents, listPlayers, listTeams, loadConfig, updateConfig } from '@data/league'
import { addTalk, closeThread, commentCount, getThread, openDisputes, openThread, openThreadCount, recentThreads, reopenThread, talkLines, threadsOfPage, threadSummary } from '@data/talk'
import { listAwards } from '@data/moves'
import { readDraftOutlook } from '@data/draftOutlook'
import { playoffsView, seasonBoxLines, standings } from '@data/season'
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
import { columnFor } from '@shared/boxcheck'
import { bodyText, heightCm, positionOf, ratingLabel, ratingShort, SPLITS, statLabel } from '@shared/labels'
import { playedMode, roundLabel } from '@shared/played'
import { refuse } from '@data/rules'
import { readLeague, type League } from '@story/context'
import { autoOverview, fallbackPlayStyle, numberRanges, positionLine, ratedColumns, relationsOf, roleOf, specialties } from '@story/playerPage'
import { OVERVIEW, PLAY_STYLE, schoolPlace, seedWiki, syncSchoolCategories, upgradeWiki, wikiTitles, type WikiTitles } from '@story/wiki'
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
  /** The league with its lore (read only for the pages that need it: players' and schools'). */
  league: () => League
}

/** The stats a player's 시즌별 활약 table shows per game, in this order (those the league tracks). */
const SEASON_STATS = ['points', 'rebounds', 'assists', 'steals', 'blocks'] as const
/** And the shooting splits after them. */
const SEASON_SPLITS = SPLITS.filter((s) => s.key !== 'ft%')

/** A school's colours: its lore's when the file sets some, else 리그 설정's. */
function schoolColors(league: League | null, team: Team | undefined): string[] {
  if (!team) return []
  const lore = league?.lore.team.get(team.id)
  const own = lore?.kind === 'team' ? lore.settings.colors : []
  return own.length ? own : team.colors
}

const STAGES: Record<string, string> = { regular: '정규', 'play-in': '플레이-인', playoffs: '플레이오프', finals: '파이널' }

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

  /** Seeds missing pages (new players, a new season) at most once a minute. Pages from before the Korean layout catch up first (once). */
  ensure(db: Db, folder: string, force = false): void {
    upgradeWiki(db, Date.now())
    const last = storyValue(db, SEEDED)
    if (!force && pageCount(db) > 0 && last !== null && Date.now() - Date.parse(last) < 60_000) return
    const league = readLeague(db, folder)
    seedWiki(db, league.config, league.lore, Date.now())
    setStoryValue(db, SEEDED, new Date().toISOString())
  }

  private ctx(db: Db, folder: string): Ctx {
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
    let league: League | null = null
    return {
      config,
      teams,
      players,
      titles,
      seasonLabels: new Map(labels.map((s) => [s.id, s.label])),
      currentSeason: season.id,
      league: () => (league ??= readLeague(db, folder)),
    }
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
    const empty: WikiData = { infobox: null, record: null, history: [], roster: null, recent: null, relations: [], auto: {} }
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
    const data = this.data(db, folder, page)
    // The app's own text links too (a player's school, his ties, the infobox's rivals), and red links work there the same.
    const links = [
      ...parseWiki(body.body).links,
      ...Object.values(data.auto).flatMap((text) => parseWiki(text).links),
      ...data.relations.flatMap((r) => (r.link ? [r.link] : [])),
      ...(data.infobox?.rows ?? []).flatMap((r) => (r.wiki ? parseWiki(r.value).links : [])),
    ]
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
      data,
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

  private data(db: Db, folder: string, page: PageRow): WikiData {
    const ctx = this.ctx(db, folder)
    const none: WikiData = { infobox: null, record: null, history: [], roster: null, recent: null, relations: [], auto: {} }
    switch (page.kind) {
      case 'player': {
        const p = ctx.players.find((x) => x.id === page.refId)
        if (!p) return none
        const league = ctx.league()
        const relations = relationsOf(league, p.id, ctx.titles.player)
        return {
          ...none,
          infobox: this.playerBox(db, ctx, league, p, relations),
          record: this.playerRecord(db, ctx, league, p),
          history: this.playerHistory(db, ctx, p),
          relations,
          auto: this.playerAuto(ctx, league, p),
        }
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

  /**
   * A player's box, as Namuwiki's: his school above his name in its colours;
   * 소속, 포지션 (in Korean and bold, the slot's abbreviation once, "/
   * 에이스" for the lineup's best), 신체 (cm first), 특기 (his ratings of A-
   * and up), 라이벌 (public ties), 별명 and 수상, each only when there's
   * something to say; then his 2K ratings in Korean, folded away.
   */
  private playerBox(db: Db, ctx: Ctx, league: League, p: PlayerRow, relations: WikiRelation[]): Infobox {
    const { config } = ctx
    const team = ctx.teams.find((t) => t.id === p.teamId)
    const rows: Infobox['rows'] = []
    const add = (row: Infobox['rows'][number]) => void (row.value || row.swatches?.length ? rows.push(row) : 0)
    add({ label: '소속', value: team?.name ?? '', link: team ? (ctx.titles.team.get(team.id) ?? null) : null })
    add({ label: '포지션', value: positionLine(config, p.slotId, roleOf(config, ctx.players, p)), link: null, wiki: true })
    add({ label: '신체', value: bodyText(p.heightCm, p.height, config.playerFields.heightUnit), link: null })
    add({ label: '특기', value: specialties(ratedColumns(config, p.ratings, numberRanges(config, ctx.players))).map((x) => x.label).join(', '), link: null })
    const rivals = relations.filter((r) => r.kind === 'rival' && !r.rumor).map((r) => (r.link ? (r.link === r.name ? `[[${r.name}]]` : `[[${r.link}|${r.name}]]`) : r.name))
    add({ label: '라이벌', value: rivals.join(', '), link: null, wiki: true })
    add({ label: '별명', value: p.nicknames.join(', '), link: null })
    add({ label: '수상', value: this.awardsOf(db, ctx, p.id), link: null })
    const has = (v: unknown) => v !== null && v !== undefined && v !== ''
    // The overall first, then the rest as the sheet orders them.
    const columns = [...config.ratings.columns.filter((c) => c.id === config.ratings.overallColumnId), ...config.ratings.columns.filter((c) => c.id !== config.ratings.overallColumnId)]
    const ratings = columns.filter((c) => has(p.ratings[c.id])).map((c) => ({ label: ratingLabel(c), value: String(p.ratings[c.id]), grade: c.kind === 'grade', source: c.name }))
    return { band: team?.shortName ?? null, title: p.name, subtitle: null, colors: schoolColors(league, team), rows, ratings: ratings.length ? { title: '능력치', rows: ratings } : null }
  }

  /**
   * His awards for the infobox: season awards by season ("시즌 1 MVP"), weekly
   * and monthly ones counted, with the group they were won in ("동부 이주의 선수 3회").
   */
  private awardsOf(db: Db, ctx: Ctx, playerId: string): string {
    const out: string[] = []
    const counted = new Map<string, number>()
    for (const [sid, label] of ctx.seasonLabels) {
      for (const a of listAwards(db, sid, ctx.config)) {
        if (a.playerId !== playerId) continue
        const season = ctx.config.awards.season.find((x) => x.id === a.awardId)
        if (season) out.push(`${label} ${season.name}${a.teamRank > 1 ? ` ${a.teamRank}팀` : ''}`)
        else {
          const name = awardTitle(ctx.config, { awardId: a.awardId, group: a.group })
          counted.set(name, (counted.get(name) ?? 0) + 1)
        }
      }
    }
    for (const [name, n] of counted) out.push(n > 1 ? `${name} ${n}회` : name)
    return out.join(', ')
  }

  /** What a player page shows in its 개요 and 플레이 스타일 while nobody has written there (see AUTO_SECTIONS). */
  private playerAuto(ctx: Ctx, league: League, p: PlayerRow): Record<string, string> {
    const team = ctx.teams.find((t) => t.id === p.teamId)
    const role = roleOf(ctx.config, ctx.players, p)
    const slot = ctx.config.roster.slots.find((s) => s.id === p.slotId)
    const position = positionOf(ctx.config, p.slotId)
    const overview = autoOverview({
      team: team ? { title: ctx.titles.team.get(team.id) ?? team.shortName, name: team.name, short: team.shortName } : null,
      position,
      starter: slot?.starter ?? true,
      role,
      nicknames: p.nicknames,
      // 공개 only: never 소문 or 비밀.
      lore: league.lore.player.get(p.id)?.sections.public ?? '',
    })
    const rated = ratedColumns(ctx.config, p.ratings, numberRanges(ctx.config, ctx.players))
    const style = fallbackPlayStyle(rated, p.id, { school: team?.shortName ?? '', position, role })
    return { ...(overview ? { [OVERVIEW]: overview } : {}), ...(style ? { [PLAY_STYLE]: style } : {}) }
  }

  /**
   * 시즌별 활약: a row per season (his school, games, then 득점, 리바운드,
   * 어시스트, 스틸 and 블록 a game, 야투율 and 3점 슛 성공률, as far as the
   * league's box scores track them), and 통산 under them once there are two.
   * A figure that led the league that season, or is his best season's, is in
   * bold; the header is in his school's colours.
   */
  private playerRecord(db: Db, ctx: Ctx, league: League, p: PlayerRow): WikiTable {
    const { config } = ctx
    const cols = SEASON_STATS.flatMap((m) => config.stats.columns.filter((c) => c.meaning === m).slice(0, 1))
    const splits = SEASON_SPLITS.flatMap((s) => {
      const made = columnFor(config, s.made)
      const tried = columnFor(config, s.tried)
      return made && tried ? [{ key: s.key, label: s.label, made, tried }] : []
    })
    const lines = db
      .prepare('SELECT g.season_id, b.team_id, b.stats FROM box_lines b JOIN games g ON g.id = b.game_id WHERE b.player_id = ? ORDER BY g.season_id')
      .all(p.id) as { season_id: number; team_id: string; stats: string }[]
    type Sums = { team: string; games: number; sums: number[]; shots: { made: number; tried: number }[] }
    const blank = (team: string): Sums => ({ team, games: 0, sums: cols.map(() => 0), shots: splits.map(() => ({ made: 0, tried: 0 })) })
    const bySeason = new Map<number, Sums>()
    const all = blank('')
    for (const l of lines) {
      const s = bySeason.get(l.season_id) ?? blank(l.team_id)
      const stats = JSON.parse(l.stats) as Record<string, number>
      for (const into of [s, all]) {
        into.games++
        cols.forEach((c, i) => (into.sums[i]! += stats[c.id] ?? 0))
        splits.forEach((x, i) => {
          into.shots[i]!.made += stats[x.made] ?? 0
          into.shots[i]!.tried += stats[x.tried] ?? 0
        })
      }
      s.team = l.team_id
      bySeason.set(l.season_id, s)
    }
    // Per game, then the splits (a split with no attempts is no figure).
    const figures = (s: Sums): (number | null)[] => [...s.sums.map((v) => v / s.games), ...s.shots.map((x) => (x.tried > 0 ? x.made / x.tried : null))]
    const shown = (s: Sums) => figures(s).map((v, i) => (v === null ? '–' : i < cols.length ? v.toFixed(1) : `${(v * 100).toFixed(1)}%`))
    // Who led the league in each figure, each season he played (by the leaders' own rules: half the most games played).
    const keys = [...cols.map((c) => (c.leader ? c.id : null)), ...splits.map((x) => x.key)]
    const led = (sid: number): Set<number> => {
      const totals = seasonTotals(seasonBoxLines(db, sid))
      const most = Math.max(0, ...[...totals.values()].map((t) => t.games))
      const boards = leaders(config, totals, Math.max(1, Math.ceil(most / 2)), 1)
      return new Set(keys.flatMap((key, i) => (key !== null && boards.find((b) => b.key === key)?.rows[0]?.playerId === p.id ? [i] : [])))
    }
    const seasons = [...bySeason]
    // His best season in each figure, once he has more than one.
    const best = figures(blank('')).map((_, i) => (seasons.length > 1 ? Math.max(...seasons.map(([, s]) => figures(s)[i] ?? -1)) : null))
    const rows: WikiTable['rows'] = seasons.map(([sid, s]) => {
      const mine = figures(s)
      const leading = led(sid)
      const bold = mine.flatMap((v, i) => (v !== null && v > 0 && (leading.has(i) || v === best[i]) ? [3 + i] : []))
      return {
        cells: [ctx.seasonLabels.get(sid) ?? String(sid), this.teamName(ctx, s.team), String(s.games), ...shown(s)],
        link: ctx.titles.team.get(s.team) ?? null,
        ...(bold.length ? { bold } : {}),
      }
    })
    if (seasons.length > 1) rows.push({ cells: ['통산', '', String(all.games), ...shown(all)], link: null, total: true })
    const team = ctx.teams.find((t) => t.id === p.teamId)
    return { columns: ['시즌', '소속', '경기', ...cols.map((c) => statLabel(c)), ...splits.map((x) => x.label)], linkColumn: 1, rows, colors: schoolColors(league, team) }
  }

  /** A player's season: trades, draft moves, going between the starters and the bench, awards and big games, oldest first. */
  private playerHistory(db: Db, ctx: Ctx, p: PlayerRow): HistoryItem[] {
    const out: HistoryItem[] = []
    const season = (id: number | null) => (id === null ? '' : (ctx.seasonLabels.get(id) ?? ''))
    for (const e of listEvents(db)) {
      const x = e.payload as Record<string, unknown>
      if (e.type === 'trade_applied' && (x.players as string[]).includes(p.id)) {
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `트레이드: ${(x.teams as string[]).map((t) => this.teamName(ctx, t)).join(' ↔ ')}` })
      } else if (e.type === 'award_given' && x.playerId === p.id) {
        // "수상: 3주차 동부 이주의 선수": the group as it was given (the event keeps it).
        const a = x as EventPayloads['award_given']
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `수상: ${awardTitle(ctx.config, a)}${a.teamRank > 1 ? ` ${a.teamRank}팀` : ''}` })
      } else if (e.type === 'draft_protect' && x.playerId === p.id) {
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `드래프트: ${this.teamName(ctx, x.teamId as string)}의 보호 선수로 지정` })
      } else if (e.type === 'draft_swap' && (x.playerId === p.id || x.targetPlayerId === p.id)) {
        const to = x.playerId === p.id ? (x.targetTeamId as string) : (x.teamId as string)
        out.push({ at: e.createdAt, season: season(e.seasonId), text: `드래프트 스왑으로 ${this.teamName(ctx, to)} 이적` })
      } else if (e.type === 'slots_changed') {
        // Only going between the starters and the bench: the position itself is in the infobox.
        const c = (x.changes as EventPayloads['slots_changed']['changes']).find((y) => y.playerId === p.id)
        const move = c ? rotationMove(ctx.config.roster, c.from, c.to) : null
        const slot = (id: string | null) => positionOf(ctx.config, id) || '–'
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

  /**
   * A school's box, as Namuwiki's: "가람고등학교 농구부" in its colours; 소속
   * (the league, conference and division), 팀 컬러 as swatches, 이번 시즌
   * (record and place), 드래프트 카드 (a card-swap league's: held now, and
   * what it's on track to have), 최고 성적 (its best playoff finish) and
   * 라이벌, each only when there's something to say.
   */
  private teamBox(db: Db, ctx: Ctx, t: Team): Infobox {
    const league = ctx.league()
    const view = standings(db)
    const rank = view.overall.findIndex((s) => s.teamId === t.id)
    const line = view.overall[rank]
    const colors = schoolColors(league, t)
    const rows: Infobox['rows'] = []
    const add = (row: Infobox['rows'][number]) => void (row.value || row.swatches?.length ? rows.push(row) : 0)
    // "테스트 리그 동 컨퍼런스 · 북 디비전".
    add({ label: '소속', value: [ctx.config.league.name, schoolPlace(ctx.config, t.divisionId).join(' · ')].filter(Boolean).join(' '), link: ctx.titles.league })
    add({ label: '팀 컬러', value: '', link: null, swatches: colors })
    if (line) add({ label: '이번 시즌', value: `${line.wins}승 ${line.losses}패 (${rank + 1}위)`, link: ctx.titles.season })
    add({ label: '드래프트 카드', value: this.draftCards(db, t.id), link: ctx.titles.draft })
    add({ label: '최고 성적', value: this.bestFinish(db, ctx, t.id), link: null })
    const lore = league.lore.team.get(t.id)
    const rivals = (lore?.kind === 'team' ? lore.settings.rivals : []).map((r) => {
      const team = ctx.teams.find((x) => x.shortName === r)
      return team ? `[[${ctx.titles.team.get(team.id) ?? team.shortName}]]` : r
    })
    add({ label: '라이벌', value: rivals.join(', '), link: null, wiki: true })
    return { title: `${t.name} 농구부`, subtitle: null, colors, rows }
  }

  /**
   * A school's draft cards for its box: held now, and what it's on track to
   * have at the draft ("3장 보유 · 드래프트 예상 4장"); in the draft, the cards
   * it has left. '' without the card-swap draft.
   */
  private draftCards(db: Db, teamId: string): string {
    const o = readDraftOutlook(db)
    const s = o?.schools.find((x) => x.teamId === teamId)
    if (!o || !s) return ''
    if (s.frozen) return '동결 (드래프트 불참)'
    if (o.room) return `남은 카드 ${s.held.length}장`
    const held = `${s.held.length}장 보유`
    if (o.final) return `${held} · 드래프트 때 ${s.projected}장`
    return o.phase === 'regular' && o.played > 0 ? `${held} · 드래프트 예상 ${s.projected}장` : held
  }

  /** How far a school went in a season's playoffs, as its season table says it, coloured; null when the season had none (yet). */
  private playoffFinish(db: Db, seasonId: number, teamId: string): { text: string; tone: CellTone | null; rank: number } | null {
    const view = playoffsView(db, seasonId)
    if (!view.seeds && view.series.length === 0) return null
    const mine = view.series.filter((s) => s.high === teamId || s.low === teamId)
    if (mine.length === 0) return view.seeds ? { text: '탈락', tone: 'blue', rank: 0 } : null
    if (mine.some((s) => s.winner === null)) return { text: '진행 중', tone: null, rank: 0 }
    if (leagueChampion(view.series) === teamId) return { text: '우승', tone: 'gold', rank: 5 }
    if (mine.some((s) => s.winner !== teamId && seriesTitle(view.series, s) === 'league')) return { text: '준우승', tone: 'silver', rank: 4 }
    if (mine.some((s) => s.winner === teamId && seriesTitle(view.series, s) === 'group')) return { text: '컨퍼런스 우승', tone: 'orange', rank: 3 }
    const deepest = mine.filter((s) => s.stage === 'playoffs').sort((a, b) => b.round - a.round)[0]
    return deepest ? { text: `플레이오프 ${deepest.round}라운드`, tone: 'orange', rank: 1 + deepest.round / 100 } : { text: '플레이-인 탈락', tone: 'blue', rank: 0 }
  }

  /** A school's best playoff finish over its seasons ("시즌 1 우승"), the latest of equals; '' before it has made one. */
  private bestFinish(db: Db, ctx: Ctx, teamId: string): string {
    let best: { label: string; text: string; rank: number } | null = null
    for (const [sid, label] of ctx.seasonLabels) {
      const f = this.playoffFinish(db, sid, teamId)
      if (f && f.rank > 0 && (!best || f.rank >= best.rank)) best = { label, text: f.text, rank: f.rank }
    }
    return best ? `${best.label} ${best.text}` : ''
  }

  /**
   * 시즌별 성적: a row per season with its place ("2위/8팀"), how far it went
   * in the playoffs (우승 gold, 준우승 silver, 진출 orange, 탈락 blue), and its
   * regular-season record. The header is in the school's colours.
   */
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
      columns: ['시즌', '순위', '플레이오프', '승', '패', '승률'],
      linkColumn: 0,
      rows: rows.map((r) => {
        const table = standings(db, r.season_id).overall
        const at = table.findIndex((s) => s.teamId === t.id)
        const finish = this.playoffFinish(db, r.season_id, t.id)
        return {
          cells: [ctx.seasonLabels.get(r.season_id) ?? String(r.season_id), at >= 0 ? `${at + 1}위/${table.length}팀` : '', finish?.text ?? '', String(r.w), String(r.l), pct(r.w, r.l)],
          link: null,
          ...(finish?.tone ? { tones: { 2: finish.tone } } : {}),
        }
      }),
      colors: schoolColors(ctx.league(), t),
    }
  }

  /** A school's roster: name, position, height (cm), then every rating column, the overall first, under its Korean name. */
  private roster(ctx: Ctx, t: Team): WikiTable {
    const { config } = ctx
    const slotOrder = (id: string | null) => config.roster.slots.findIndex((s) => s.id === id)
    const overall = config.ratings.columns.filter((c) => c.id === config.ratings.overallColumnId)
    const ratings = [...overall, ...config.ratings.columns.filter((c) => c.id !== config.ratings.overallColumnId)]
    const shown = (label: string, source: string) => (label === source ? null : source)
    return {
      columns: ['이름', '포지션', '신장', ...ratings.map((c) => ratingShort(c))],
      linkColumn: 0,
      rows: ctx.players
        .filter((p) => p.teamId === t.id)
        .sort((a, b) => slotOrder(a.slotId) - slotOrder(b.slotId))
        .map((p) => ({
          cells: [p.name, positionOf(config, p.slotId), heightCm(p.heightCm, p.height), ...ratings.map((c) => String(p.ratings[c.id] ?? ''))],
          link: ctx.titles.player.get(p.id) ?? null,
        })),
      grades: ratings.flatMap((c, i) => (c.kind === 'grade' ? [3 + i] : [])),
      hints: [null, null, null, ...ratings.map((c) => shown(ratingShort(c), c.name))],
      colors: schoolColors(ctx.league(), t),
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
          cells: [g.stage === 'regular' ? roundLabel(ctx.config, g.round, 'long') : `${STAGES[g.stage] ?? g.stage} ${g.round}차전`, `${home ? 'vs' : '@'} ${this.teamName(ctx, vs)}`, `${us > them ? '승' : '패'} ${us}:${them}`],
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

  /** Every season's winners: the award with the group it was won in ("동부 이주의 선수"), and its period (3주차, 11월). */
  private awardsTable(db: Db, ctx: Ctx): WikiTable {
    const rows: WikiTable['rows'] = []
    for (const [sid, label] of ctx.seasonLabels) {
      for (const a of listAwards(db, sid, ctx.config)) {
        const player = ctx.players.find((p) => p.id === a.playerId)
        rows.push({
          cells: [label, `${awardTitle(ctx.config, { awardId: a.awardId, group: a.group })}${a.teamRank > 1 ? ` ${a.teamRank}팀` : ''}`, periodLabel(a.period), player?.name ?? a.playerId],
          link: ctx.titles.player.get(a.playerId) ?? null,
        })
      }
    }
    return { columns: ['시즌', '상', '기간', '선수'], linkColumn: 3, rows }
  }
}
