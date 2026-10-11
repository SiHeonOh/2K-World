import { roundLabel } from '@shared/played'

/**
 * 2K 일정대로 (`season.schedule.build: 'played'`): no rounds; each game is
 * picked as it's played, into the open session (N일차), and 오늘 경기 끝
 * closes the session. Merged into ko as `played`; its wizard words into
 * `wizard.season`, its setup issue into the wizard's issues, its refusals
 * into `rules`.
 */

type P = Record<string, string | number>

export const playedText = {
  session: (n: number) => roundLabel(true, n),
  /** Accessible name of a session tab; the ✓ mark is only visual. */
  sessionTab: (n: number, status: 'closed' | 'open' | 'empty') => `${n}일차${{ closed: ', 끝남', open: ', 진행 중', empty: ', 경기 없음' }[status]}`,
  openBadge: '진행 중',
  closedBadge: '끝남',
  jumpOpen: '진행 중인 일차로',
  notStarted: '시즌을 시작하면 경기할 때마다 두 학교를 골라 기록할 수 있어요 (2K 일정대로).',
  preseasonHelp: '시즌을 시작하면 2K에서 경기를 마칠 때마다 두 학교를 골라 기록해요 (라운드 없음). 카드 드래프트 리그는 팀마다 확정된 카드가 생겨요.',
  emptySession: '아직 이 일차에 경기가 없어요. 아래에서 방금 2K에서 끝난 경기의 두 학교를 고르세요.',
  closedSession: '끝난 일차예요. 새 경기는 진행 중인 일차에 들어가요.',
  progress: (played: number, total: number) => `정규시즌 ${played} / ${total}경기 · 모든 학교가 서로 다 만나면 끝나요`,

  // Adding a game.
  pickerTitle: (n: number) => `${n}일차에 경기 추가`,
  pickFirst: '방금 2K에서 끝난(또는 할) 경기의 홈 학교를 고르세요. 이어서 상대를 고르면 돼요. 숫자는 지금까지 치른 경기 수예요.',
  pickSecond: (team: string) => `${team}의 상대를 고르세요. 아직 맞대결이 남은 학교만 보여요.`,
  noOpponents: (team: string) => `${team}은(는) 모든 학교와 맞대결을 다 했어요.`,
  gp: (n: number) => `${n}경기`,
  meetingsLeft: (n: number) => `남은 맞대결 ${n}`,
  staged: (home: string, away: string) => `${home} (홈) vs ${away} (원정)`,
  flip: '홈/원정 바꾸기',
  add: '이 경기 추가',
  repick: '다시 고르기',
  added: (n: number) => `${n}일차에 경기를 넣었어요. 스크린샷으로 읽거나 직접 입력해서 기록하세요.`,
  allMet: '모든 학교가 서로 다 만났어요. 더 넣을 경기가 없어요.',
  loading: '학교 목록을 불러오는 중…',

  // 오늘 경기 끝.
  endDay: '오늘 경기 끝',
  endDayHelp: (n: number) => `오늘 2K 경기를 다 기록했으면 눌러 주세요. ${n}일차를 끝내고 다음 일차를 열어요.`,
  endEmpty: (n: number) => `${n}일차에 아직 경기가 없어요. 경기를 넣고 기록한 뒤에 끝낼 수 있어요.`,
  endUnplayed: (n: number, count: number) => `${n}일차에 아직 기록하지 않은 경기가 ${count}개 있어요. 기록하거나 빼야 끝낼 수 있어요:`,
  removeGame: '빼기',
  /** `window`: 'now' when this session's close opens a trade window, else the session after which the next one opens (null: none will). */
  confirmEnd: (p: { round: number; games: number; community: boolean; loreSweep: boolean; window: 'now' | number | null }) =>
    [
      `${p.round}일차를 끝낼까요? (경기 ${p.games}개)`,
      '',
      '끝내면:',
      p.community ? '· 커뮤니티에 일차 정리 기사와 반응 글이 올라와요.' : '· 커뮤니티가 꺼져 있어서 일차 정리 글은 올라오지 않아요.',
      p.community ? '· 위키 편집자들이 활약한 선수 문서의 이번 시즌 문단을 고쳐요.' : null,
      p.loreSweep ? '· 이번 일차를 보고 로어에 남길 만한 것을 골라 제안함에 넣어요.' : null,
      p.window === 'now' ? '· 트레이드 창 차례예요: AI 단장들이 트레이드를 시도해요.' : p.window !== null ? `· 다음 트레이드 창은 ${p.window}일차가 끝나면 열려요.` : null,
      '· 이 일차를 기다리던 커뮤니티 투표가 마감돼요.',
      `· 이제부터 넣는 경기는 ${p.round + 1}일차에 들어가요.`,
      '',
      '끝낸 일차는 다시 열 수 없어요 (점수 고치기와 기록 취소는 그대로 돼요). 끝내기 전에 리그를 백업해 둬요.',
    ]
      .filter((l): l is string => l !== null)
      .join('\n'),
  closed: (n: number, next: number) => `${n}일차를 끝냈어요. 이제 ${next}일차예요.`,
  ending: '끝내는 중…',

  // 경기일.
  typeHelp: '스크린샷이 없으면 "스크린샷 없이 직접 입력"을 눌러 점수와 박스스코어를 손으로 넣어요.',
  noOpenGames: '기록할 경기가 없어요. 위에서 방금 2K에서 끝난 경기의 두 학교를 고르세요.',

  // 순위.
  gpColumn: '경기',
  standingsNote: '2K 일정대로라 학교마다 치른 경기 수가 달라요. 순위는 승률 순이고, 게임차는 1위와 승패 차이예요 (경기를 더 치른 학교는 음수일 수 있어요).',

  // 시즌 카드.
  playoffsNote: '마지막 일차를 아직 끝내지 않았으면 플레이오프를 시작할 때 함께 끝내요 (일차 정리 글이 올라와요).',

  // 리그 설정: switching a running season.
  switchTitle: '시즌 중에 2K 일정대로로 바꾸기',
  switchHelp:
    '라운드 방식으로 시작한 시즌도 2K 일정대로로 바꿀 수 있어요. 지금까지 치른 라운드는 1일차부터 차례로 끝난 일차가 되고, 다음 경기부터는 그다음 일차에 들어가요. 바꾼 뒤에는 이번 시즌 동안 되돌릴 수 없어요 (다음 시즌 전에 바꿀 수 있어요).',
  switchButton: '2K 일정대로로 바꾸기',
  confirmSwitch:
    '이번 시즌을 2K 일정대로로 바꿀까요?\n\n· 지금까지 치른 라운드는 끝난 일차가 돼요.\n· 앞으로는 경기할 때마다 두 학교를 골라 넣고, 그날 경기를 마치면 "오늘 경기 끝"을 눌러요.\n· 이번 시즌 동안은 되돌릴 수 없어요.\n\n저장하기 전에 리그를 백업해 둬요.',
  switched: '2K 일정대로로 바꿨어요. 일정에서 경기를 넣으세요.',

  // The wizard's schedule card (spread into wizard.season).
  build: { played: '2K 일정대로' },
  buildHelp: {
    played:
      '경기할 때마다 두 학교를 골라 기록해요 (라운드 없음). 2K처럼 어떤 날은 몇 학교만 뛰니까, 학교마다 치른 경기 수가 달라도 괜찮아요. 그날 경기를 마치면 일정이나 경기일에서 "오늘 경기 끝"을 눌러요: 그날 경기가 N일차로 묶이고, 일차 정리 글·위키·로어 제안·트레이드 창·투표 마감이 이어져요. 모든 학교가 서로 정해진 횟수만큼 만나면 정규시즌이 끝나요.',
  },

  // The setup check (spread into the wizard's issues).
  issues: {
    'played-needs-round-robin': () => "'2K 일정대로'는 라운드 로빈에서만 쓸 수 있어요. 경기 수를 직접 정한 리그는 시즌을 시작할 때 일정이 만들어져요",
  },

  rules: {
    'schedule-not-played': () => '이 리그는 2K 일정대로 리그가 아니에요. 일정 화면에서 라운드 대진을 짜 주세요',
    'schedule-played': () => '2K 일정대로 리그는 라운드를 짜지 않아요. 방금 경기한 두 학교를 골라 넣어 주세요',
    'session-empty': (p: P) => `${p.round}일차에 아직 경기가 없어요. 경기를 넣고 기록한 뒤에 끝낼 수 있어요`,
    'session-unplayed': (p: P) => `${p.round}일차에 아직 기록하지 않은 경기가 ${p.count}개 있어요 (${p.games}). 기록하거나 뺀 뒤에 끝내 주세요`,
    'settings-played-unplayed': (p: P) =>
      `일정: 아직 치르지 않은 경기가 ${p.count}개 짜여 있어서 2K 일정대로로 바꿀 수 없어요. 그 경기를 기록하거나, 일정에서 빼거나 라운드를 비운 뒤에 바꿔 주세요`,
    'settings-played-leave': () => '일정: 2K 일정대로는 시즌이 시작되면 다른 방식으로 바꿀 수 없어요. 다음 시즌을 시작한 뒤(시즌 전)에 바꿔 주세요',
  } as Record<string, (p: P) => string>,
}
