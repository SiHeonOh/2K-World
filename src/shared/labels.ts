import type { LeagueConfig, RatingColumn, StatColumn, StatMeaning } from './config/schema'

/**
 * Korean display names, one source of truth for the wiki, the League Office
 * tables, the roster editor and the AI writers' facts:
 * - rating columns: the column's own label (리그 설정), else a dictionary of
 *   2K's names (matched ignoring case, spaces and dots), else its name as written;
 * - stat columns by what they mean (득점, 리바운드…), shooting splits (야투율);
 * - roster slots as positions (SF → 스몰 포워드), heights in cm.
 * Only what's shown changes: ids, values and the source sheet's names stay.
 */

/** How a name is looked up: lower case, no spaces, dots, dashes, slashes or underscores ("Inside D" → "insided"). */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase().replace(/[\s._\-/·]+/g, '')

/** The side of the game a rating measures, for wording a player's type (슈터, 볼 핸들러, 림 프로텍터…). */
export type SkillKind = 'shoot' | 'inside' | 'play' | 'rim' | 'perimeter' | 'board' | 'body' | 'mind'

interface Name {
  /** As the infobox and the tables show it. */
  label: string
  /** For dense tables, when shorter than the label. */
  short?: string
  /** What Namuwiki's prose calls that side of a player's game (the writers get these). */
  prose?: string[]
  kind?: SkillKind
}

/**
 * 2K's rating names as sheets write them (categories and single attributes),
 * with their Korean names as Namuwiki's basketball pages write them.
 */
const RATINGS: [string[], Name][] = [
  [['ovr', 'overall', 'overallrating', 'ovrrating', '오버롤'], { label: '종합', prose: ['종합 능력치', '오버롤'] }],
  [['insidescoring', 'inside', 'insidescore', 'interiorscoring', 'insideoffense'], { label: '골밑 득점', prose: ['골밑 마무리', '림 어택', '포스트업'], kind: 'inside' }],
  [['outsidescoring', 'outside', 'outsidescore', 'perimeterscoring'], { label: '외곽 득점', prose: ['외곽 슛'], kind: 'shoot' }],
  [['midrange', 'mid', 'midrangeshot', 'midrangeshooting', 'mrshot'], { label: '중거리 슛', prose: ['미드레인지 점퍼', '풀업 점퍼'], kind: 'shoot' }],
  [
    ['3pt', '3p', '3pts', 'three', 'threes', '3point', 'threepoint', '3ptshot', 'threepointshot', '3pointshot', '3ptshooting', 'threepointshooting'],
    { label: '3점 슛', prose: ['외곽 슛', '캐치 앤 샷'], kind: 'shoot' },
  ],
  [
    ['insided', 'insidedefense', 'interiord', 'interiordefense', 'intd', 'paintdefense', 'postdefense'],
    { label: '골밑 수비', prose: ['림 프로텍팅', '블록슛', '세로 수비'], kind: 'rim' },
  ],
  [['perimeterd', 'perimeterdefense', 'perd', 'perimeter', 'outsidedefense'], { label: '외곽 수비', prose: ['대인 수비', '앞선 수비', '가로 수비'], kind: 'perimeter' }],
  [['playmaking', 'playmaker', 'passingandhandling'], { label: '플레이메이킹', prose: ['볼 핸들링', '패스', '시야', '경기 운영'], kind: 'play' }],
  [['rebound', 'rebounding', 'rebounds', 'reb'], { label: '리바운드', prose: ['박스아웃', '제공권'], kind: 'board' }],
  [['offensiverebound', 'offensiverebounding', 'oreb'], { label: '공격 리바운드', prose: ['풋백'], kind: 'board' }],
  [['defensiverebound', 'defensiverebounding', 'dreb'], { label: '수비 리바운드', prose: ['박스아웃'], kind: 'board' }],
  [['athleticism', 'athletic', 'athletics', 'ath'], { label: '운동 능력', prose: ['스피드', '점프력', '순발력', '체력'], kind: 'body' }],
  // "BQ" is 2K's own word; written in Korean, as the user asked for less English.
  [['bq', 'basketballiq', 'biq', 'iq', 'bballiq'], { label: '농구 센스', prose: ['판단력', '위치 선정'], kind: 'mind' }],
  [['defense', 'defence', 'def', 'defending'], { label: '수비', kind: 'perimeter' }],
  [['shooting', 'shot', 'shoot'], { label: '슈팅', kind: 'shoot' }],
  [['scoring', 'offense', 'offence'], { label: '득점력', kind: 'inside' }],
  [['passing', 'pass', 'passaccuracy', 'passingaccuracy'], { label: '패스', prose: ['패싱 센스', '시야'], kind: 'play' }],
  [['ballhandle', 'ballhandling', 'handle', 'handles', 'dribbling', 'dribble'], { label: '볼 핸들링', kind: 'play' }],
  [['finishing', 'finish'], { label: '마무리', kind: 'inside' }],
  [['closeshot', 'close'], { label: '근거리 슛', kind: 'inside' }],
  [['layup', 'drivinglayup'], { label: '레이업', kind: 'inside' }],
  [['dunk', 'dunking', 'drivingdunk', 'standingdunk'], { label: '덩크', kind: 'inside' }],
  [['postcontrol', 'post', 'postgame', 'postscoring'], { label: '포스트업', kind: 'inside' }],
  [['freethrow', 'freethrows', 'ft'], { label: '자유투', kind: 'shoot' }],
  [['steal', 'steals', 'stl'], { label: '스틸', kind: 'perimeter' }],
  [['block', 'blocks', 'blk', 'shotblocking'], { label: '블록슛', kind: 'rim' }],
  [['speed', 'quickness', 'speedwithball'], { label: '스피드', kind: 'body' }],
  [['acceleration', 'agility'], { label: '순발력', kind: 'body' }],
  [['strength', 'power'], { label: '힘', kind: 'body' }],
  [['vertical', 'jumping', 'leaping'], { label: '점프력', kind: 'body' }],
  [['stamina', 'endurance'], { label: '체력', kind: 'body' }],
  [['hustle', 'effort'], { label: '허슬' }],
  [['durability', 'overalldurability'], { label: '내구성' }],
  [['clutch'], { label: '클러치' }],
  [['potential', 'pot'], { label: '잠재력' }],
]

const RATING_BY_KEY = new Map(RATINGS.flatMap(([keys, name]) => keys.map((k) => [nameKey(k), name] as const)))

/** The dictionary's Korean name for a 2K rating name, or null when it isn't in it (a placeholder for 리그 설정). */
export function builtInRatingLabel(name: string): string | null {
  return RATING_BY_KEY.get(nameKey(name))?.label ?? null
}

type Rated = Pick<RatingColumn, 'name'> & { label?: string | undefined }

/** A rating column as it's shown: its own label, else the dictionary's Korean name, else its name. */
export function ratingLabel(column: Rated): string {
  return column.label?.trim() || RATING_BY_KEY.get(nameKey(column.name))?.label || column.name
}

/** The same for a dense table, when the dictionary has a shorter one. */
export function ratingShort(column: Rated): string {
  const own = column.label?.trim()
  if (own) return own
  const known = RATING_BY_KEY.get(nameKey(column.name))
  return known?.short ?? known?.label ?? column.name
}

/** What prose calls a rating's side of the game (골밑 득점 → 골밑 마무리, 림 어택…); [] when the dictionary has none. */
export function ratingProse(column: Pick<RatingColumn, 'name'>): string[] {
  return RATING_BY_KEY.get(nameKey(column.name))?.prose ?? []
}

/** The side of the game a rating column measures, by the dictionary; null when it doesn't know the column. */
export function ratingKind(column: Pick<RatingColumn, 'name'>): SkillKind | null {
  return RATING_BY_KEY.get(nameKey(column.name))?.kind ?? null
}

/** Whether a label is Korean to read (written prose only uses those; an untranslated "Clutch" stays out of it). */
export const isKorean = (text: string) => /[가-힣]/.test(text)

// ── Box score ────────────────────────────────────────────────────────────

/** Stat columns by what they mean. */
export const STAT_KO: Record<Exclude<StatMeaning, 'other'>, string> = {
  points: '득점',
  rebounds: '리바운드',
  assists: '어시스트',
  steals: '스틸',
  blocks: '블록',
  turnovers: '턴오버',
  fgm: '야투 성공',
  fga: '야투 시도',
  tpm: '3점 슛',
  tpa: '3점 슛 시도',
  ftm: '자유투 성공',
  fta: '자유투 시도',
}

/** Columns tagged 'other', by the names box scores give them. */
const OTHER_STATS: [string[], string][] = [
  [['min', 'mins', 'minutes', 'mp'], '출전 시간'],
  [['pf', 'foul', 'fouls'], '파울'],
  [['+/-', 'pm', 'plusminus', '±'], '득실 마진'],
  [['oreb', 'or', 'offensiverebounds'], '공격 리바운드'],
  [['dreb', 'dr', 'defensiverebounds'], '수비 리바운드'],
  [['dunks', 'dnk'], '덩크'],
  [['grade', 'teammategrade'], '팀 평점'],
]
const OTHER_BY_KEY = new Map(OTHER_STATS.flatMap(([keys, label]) => keys.map((k) => [nameKey(k) || k, label] as const)))

/** A stat column's Korean header: by its meaning, else by a known box-score name, else its own name. */
export function statLabel(column: Pick<StatColumn, 'name' | 'meaning'>): string {
  if (column.meaning !== 'other') return STAT_KO[column.meaning]
  return OTHER_BY_KEY.get(nameKey(column.name) || column.name) ?? column.name
}

/** Shooting splits, made over attempts: their keys (as the league leaders name them) and Korean names. */
export const SPLITS = [
  { key: 'fg%', made: 'fgm', tried: 'fga', label: '야투율' },
  { key: '3p%', made: 'tpm', tried: 'tpa', label: '3점 슛 성공률' },
  { key: 'ft%', made: 'ftm', tried: 'fta', label: '자유투 성공률' },
] as const satisfies readonly { key: string; made: StatMeaning; tried: StatMeaning; label: string }[]

/** A league-leaders board's Korean name: a split by its key, a per-game board by its column. */
export function leaderLabel(config: Pick<LeagueConfig, 'stats'>, board: { key: string; label: string; kind: 'per-game' | 'percent' }): string {
  if (board.kind === 'percent') return SPLITS.find((s) => s.key === board.key)?.label ?? board.label
  const column = config.stats.columns.find((c) => c.id === board.key)
  return column ? statLabel(column) : board.label
}

// ── Positions and heights ────────────────────────────────────────────────

/** Roster slots as positions, by the names leagues give them. */
const POSITIONS: [string[], string][] = [
  [['pg', 'pointguard', '1', '1번', 'point'], '포인트 가드'],
  [['sg', 'shootingguard', '2', '2번'], '슈팅 가드'],
  [['sf', 'smallforward', '3', '3번'], '스몰 포워드'],
  [['pf', 'powerforward', '4', '4번'], '파워 포워드'],
  [['c', 'center', 'centre', '5', '5번'], '센터'],
  [['g', 'guard'], '가드'],
  [['f', 'forward'], '포워드'],
  [['gf', 'swingman', 'wing', 'guardforward'], '스윙맨'],
  [['fc', 'forwardcenter'], '포워드-센터'],
  [['big', 'bigman'], '빅맨'],
  [['combo', 'comboguard'], '콤보 가드'],
  [['6th', '6thman', 'sixth', 'sixthman', '6man', '6m', '6', '식스맨'], '식스맨'],
  [['bench', 'b', 'reserve', 'reserves', 'sub', 'substitute', '벤치'], '벤치 멤버'],
  [['starter'], '주전'],
]
const POSITION_BY_KEY = new Map(POSITIONS.flatMap(([keys, label]) => keys.map((k) => [nameKey(k), label] as const)))

/** A slot's name as a position (SF → 스몰 포워드, 6th Man → 식스맨); a name the dictionary doesn't know stays. */
export function positionName(slotName: string): string {
  return POSITION_BY_KEY.get(nameKey(slotName)) ?? slotName
}

/** The slot's own short name when it's an abbreviation of the position (SF for 스몰 포워드), for "(SF)" once in the infobox; else null. */
export function positionAbbr(slotName: string): string | null {
  const name = slotName.trim()
  return /^[A-Za-z]{1,3}$/.test(name) && positionName(name) !== name ? name.toUpperCase() : null
}

/** A player's position by his slot (full Korean), or '' with no slot. */
export function positionOf(config: Pick<LeagueConfig, 'roster'>, slotId: string | null): string {
  const slot = config.roster.slots.find((s) => s.id === slotId)
  return slot ? positionName(slot.name) : ''
}

/** A height for the wiki's tables: 203cm when it could be read, else as the sheet wrote it. */
export function heightCm(cm: number | null, raw = ''): string {
  return cm === null ? raw.trim() : `${Math.round(cm)}cm`
}

/** A height for the infobox's 신체 row: cm first, then feet and inches where the league keeps them ("203cm (6' 8")"). */
export function bodyText(cm: number | null, raw: string, unit: 'ft-in' | 'cm'): string {
  if (cm === null || unit === 'cm') return heightCm(cm, raw)
  const inches = Math.round(cm / 2.54)
  return `${Math.round(cm)}cm (${Math.floor(inches / 12)}' ${inches % 12}")`
}

// ── Grades ───────────────────────────────────────────────────────────────

/** Where a grade sits in the league's scale, coarsely: what the prose and the colours go by. */
export type GradeTier = 'elite' | 'strong' | 'solid' | 'average' | 'weak'

/**
 * A grade's tier by its place in the scale (best first): on the default A+
 * to F, A+ and A are elite, A- and B+ strong, B and B- solid, C+ to C-
 * average, D+ and below weak. Null for a grade the scale doesn't have.
 */
export function gradeTier(scale: readonly { label: string }[], grade: string): GradeTier | null {
  const i = scale.findIndex((g) => g.label === grade)
  if (i < 0) return null
  return tierAt(scale.length <= 1 ? 0 : i / (scale.length - 1))
}

/** A tier by position from the best (0) to the worst (1). */
export function tierAt(r: number): GradeTier {
  if (r <= 0.1) return 'elite'
  if (r <= 0.26) return 'strong'
  if (r <= 0.45) return 'solid'
  if (r <= 0.7) return 'average'
  return 'weak'
}

/**
 * How Namuwiki puts a grade into words, A+ to F: 리그 최정상급, 최상급, 상급,
 * 수준급, 준수, 평균 이상, 무난, 평범, 아쉬움, 약점, 약점, 치명적 약점,
 * 치명적 약점. Prose names grades by these words, never by their letters.
 */
export const GRADE_WORDS = ['리그 최정상급', '최상급', '상급', '수준급', '준수', '평균 이상', '무난', '평범', '아쉬움', '약점', '약점', '치명적 약점', '치명적 약점'] as const
export type GradeWord = (typeof GRADE_WORDS)[number]

/** The word for a place in the scale (0 best, 1 worst): a scale of another length is read against A+ to F. */
export const gradeWordAt = (r: number): GradeWord => GRADE_WORDS[Math.min(GRADE_WORDS.length - 1, Math.max(0, Math.round(r * (GRADE_WORDS.length - 1))))]!

/** A grade in words by the league's scale, or null for a grade the scale doesn't have. */
export function gradeWord(scale: readonly { label: string }[], grade: string): GradeWord | null {
  const i = scale.findIndex((g) => g.label === grade)
  return i < 0 ? null : gradeWordAt(scale.length <= 1 ? 0 : i / (scale.length - 1))
}
