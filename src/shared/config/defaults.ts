import {
  defaultAiJobs,
  CONFIG_VERSION,
  type CardSwapDraft,
  type CommunityConfig,
  type GradeStep,
  type LeagueConfig,
  type DraftConfig,
  type StatColumn,
} from './schema'

/** A+ (best) to F. Values feed the player value model; each is a setting. */
export const DEFAULT_GRADE_SCALE: GradeStep[] = [
  { label: 'A+', value: 100 },
  { label: 'A', value: 95 },
  { label: 'A-', value: 90 },
  { label: 'B+', value: 85 },
  { label: 'B', value: 80 },
  { label: 'B-', value: 75 },
  { label: 'C+', value: 70 },
  { label: 'C', value: 65 },
  { label: 'C-', value: 60 },
  { label: 'D+', value: 55 },
  { label: 'D', value: 50 },
  { label: 'D-', value: 45 },
  { label: 'F', value: 40 },
]

/** The lines a 2K box score shows (PTS, REB, AST, STL, BLK, TO, FG, 3PT, FT). */
export function defaultStatColumns(): StatColumn[] {
  return [
    { id: 'pts', name: 'PTS', meaning: 'points', leader: true },
    { id: 'reb', name: 'REB', meaning: 'rebounds', leader: true },
    { id: 'ast', name: 'AST', meaning: 'assists', leader: true },
    { id: 'stl', name: 'STL', meaning: 'steals', leader: true },
    { id: 'blk', name: 'BLK', meaning: 'blocks', leader: true },
    { id: 'to', name: 'TO', meaning: 'turnovers', leader: false },
    { id: 'fgm', name: 'FGM', meaning: 'fgm', leader: false },
    { id: 'fga', name: 'FGA', meaning: 'fga', leader: false },
    { id: '3pm', name: '3PM', meaning: 'tpm', leader: true },
    { id: '3pa', name: '3PA', meaning: 'tpa', leader: false },
    { id: 'ftm', name: 'FTM', meaning: 'ftm', leader: false },
    { id: 'fta', name: 'FTA', meaning: 'fta', leader: false },
  ]
}

/** A generic starting point for a new league. Nothing league-specific. */
export function defaultConfig(): LeagueConfig {
  return {
    version: CONFIG_VERSION,
    league: { name: '', shortName: '' },
    structure: {
      conferences: [],
      divisions: [{ id: 'd1', name: '디비전 1', conferenceId: null }],
    },
    roster: {
      slotMode: 'one-per-slot',
      minPlayers: 5,
      maxPlayers: 5,
      slots: [
        { id: 'pg', name: 'PG', starter: true },
        { id: 'sg', name: 'SG', starter: true },
        { id: 'sf', name: 'SF', starter: true },
        { id: 'pf', name: 'PF', starter: true },
        { id: 'c', name: 'C', starter: true },
      ],
    },
    ratings: {
      columns: [{ id: 'ovr', name: 'OVR', kind: 'number', min: 0, max: 99, weight: 1 }],
      gradeScale: DEFAULT_GRADE_SCALE.map((g) => ({ ...g })),
      overallColumnId: 'ovr',
    },
    playerFields: { heightUnit: 'ft-in' },
    stats: { columns: defaultStatColumns() },
    season: {
      label: '시즌 1',
      schedule: { kind: 'round-robin', cycles: 1, build: 'auto' },
      standings: { tiebreakers: ['head-to-head', 'point-diff', 'points-for', 'random'] },
      playoffs: {
        enabled: true,
        // A new league has no conferences yet; the wizard switches this when you add some.
        bracket: 'league',
        directSeeds: 6,
        playIn: { enabled: true, format: 'nba', bestOf: 1 },
        seriesBestOf: 7,
        finals: { kind: 'none', bestOf: 7 },
      },
      calendar: { roundsPerWeek: 3, weeksPerMonth: 4 },
    },
    awards: {
      season: [
        { id: 'mvp', name: 'MVP', kind: 'player', teams: 1, perTeam: 1, timing: 'regular-season' },
        { id: 'dpoy', name: '올해의 수비수', kind: 'player', teams: 1, perTeam: 1, timing: 'regular-season' },
        { id: 'all-league', name: '올-리그 팀', kind: 'selection', teams: 3, perTeam: 5, timing: 'regular-season' },
        { id: 'finals-mvp', name: '파이널 MVP', kind: 'player', teams: 1, perTeam: 1, timing: 'finals' },
      ],
      // League-wide: a new league has no conferences yet (the wizard goes per conference once it has two).
      periodic: [
        { id: 'potw', name: '이주의 선수', period: 'week', winners: 1, scope: 'league' },
        { id: 'potm', name: '이달의 선수', period: 'month', winners: 1, scope: 'league' },
      ],
    },
    trades: {
      enabled: true,
      phases: ['preseason', 'regular'],
      oncePerSeason: { enabled: false, until: 'draft' },
      equalPlayerCount: true,
      cardsWithPlayers: true,
      limits: { perWindow: null, maxValueGap: null },
    },
    draft: { kind: 'none' },
    gm: {
      autonomy: 'full',
      tradeWindowEveryRounds: 5,
      rumorLeaks: true,
      negotiationLog: 'live',
      gmsPerWindow: 8,
      talksPerWindow: 6,
      dealCards: 3,
      earlyCaution: true,
    },
    community: defaultCommunity(''),
    lore: { roundSweep: true, suggest: {} },
    ai: { jobs: defaultAiJobs() },
    wiki: { editWars: 'sometimes' },
  }
}

/** The main board's automatic name: the league's short name, else its name. */
export function autoMainBoard(league: LeagueConfig['league']): string {
  return (league.shortName.trim() || league.name.trim()).slice(0, 40) || '메인'
}

/** Keeps the main board named after the league until someone renames it. */
export function followLeagueName(config: LeagueConfig, before: LeagueConfig['league']): void {
  const main = config.community.boards.find((b) => b.role === 'main')
  if (main && (main.name === autoMainBoard(before) || main.name === '메인')) main.name = autoMainBoard(config.league)
}

/** Default boards and community settings; the main board takes the league's short name. */
export function defaultCommunity(mainBoard: string): CommunityConfig {
  return {
    enabled: true,
    myNick: '나',
    boards: [
      { id: 'main', name: mainBoard.trim().slice(0, 40) || '메인', role: 'main' },
      { id: 'games', name: '경기 결과/중계', role: 'games' },
      { id: 'trades', name: '트레이드·루머', role: 'trades' },
      { id: 'draft', name: '드래프트', role: 'draft' },
      { id: 'humor', name: '유머', role: 'humor' },
      { id: 'free', name: '자유', role: 'free' },
      { id: 'notice', name: '공지', role: 'notice' },
      { id: 'poten', name: '포텐', role: 'poten' },
    ],
    fans: 200,
    reporters: 5,
    maxSpice: 5,
    potenAt: 30,
    bestAt: 10,
    revealPerRefresh: 4,
    refillBelow: 8,
    chatterBatch: 30,
    dailyChatterJobs: 40,
    topicMix: {},
  }
}

/** Defaults used when a league switches its draft system in the wizard. */
export function defaultDraft(kind: DraftConfig['kind'], teamCount: number): DraftConfig {
  switch (kind) {
    case 'none':
      return { kind: 'none' }
    case 'standard':
      return { kind: 'standard', rounds: 1, order: 'reverse-rank' }
    case 'card-swap':
      return defaultCardSwap(teamCount)
  }
}

export function defaultCardSwap(teamCount: number): CardSwapDraft {
  return {
    kind: 'card-swap',
    allocation: [{ fromRank: 1, toRank: Math.max(1, teamCount), cards: 3 }],
    order: 'reverse-rank',
    protection: true,
    turns: 'one',
    slotRule: 'any',
    incomingSlot: 'replaced',
    swappedProtected: true,
    unusedCards: 'expire',
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: null, capCounts: 'given' },
    pickSlot: 'original-owner',
  }
}
