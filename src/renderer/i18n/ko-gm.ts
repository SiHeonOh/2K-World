/** 단장실: the AI GMs' trade windows, negotiation log and plans (merged into ko as `gm`). */

/** A round's short name: "R5", or "5일차" in 2K 일정대로 (the screens pass `roundLabel`'s). */
type RoundName = (n: number) => string
const R: RoundName = (n) => `R${n}`

/** The parts of a GM's value report past strength and value (shared/gm.ts ValueReport). */
interface ReportMore {
  stance?: string
  draft?: { cards: number; cardsAfter: number; exposed: string[] }
  rolesLost?: string[]
  rolesFilled?: string[]
  bar?: number
  versusAsk?: { dropped: string[]; added: string[]; value: number; strength: number }
}
const STANCES: Record<string, string> = { contender: '경쟁권', bubble: '중위권', rebuilding: '리빌딩' }
const ROLES: Record<string, string> = { handler: '볼 핸들러', big: '골밑·리바운드 빅맨', shooter: '외곽 슈터', stopper: '외곽 수비수' }
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`

export const gmText = {
  title: '단장실',
  intro: '학교마다 AI 단장이 트레이드 창이 열릴 때 누구를 노리고 어떻게 협상했는지 볼 수 있어요. 속마음은 상대 단장은 못 보는 진짜 이유예요.',
  windowOpen: (round: number | null, name: RoundName = R) => (round !== null ? `트레이드 창 열림 · ${name(round)} 이후` : '트레이드 창 열림'),
  working: (n: number) => `단장들이 움직이는 중… (남은 작업 ${n}건)`,
  windowClosed: '트레이드 창 닫힘',
  nextWindow: (round: number, name: RoundName = R) => `다음 창은 ${name(round)} 일정이 끝나면 열려요.`,
  manualOnly: '트레이드 창은 직접 열 때만 열려요. 원할 때 오른쪽 버튼을 누르세요.',
  openNow: '지금 트레이드 창 열기',
  confirmOpen: '지금 트레이드 창을 열까요? 의욕 있는 단장들이 차례로 움직여요. Claude를 여러 번 부르고, 성사된 트레이드는 2K 체크리스트에 올라가요.',
  opened: (n: number) => (n > 0 ? `단장 ${n}명이 움직이기 시작했어요.` : '지금은 마땅한 거래를 찾은 단장이 없어서 창을 열지 않았어요.'),
  blocked: {
    phase: '지금 시기에는 트레이드를 할 수 없어요.',
    open: '트레이드 창이 이미 열려 있어요.',
    'no-ai': 'AI 단장이 운영하는 학교가 없어요.',
  } as Record<string, string>,
  aiOff: 'Claude Code를 쓸 수 없어서 단장들이 움직이지 않아요. 앱 설정에서 확인하세요.',

  approvals: '승인 대기',
  approvalsHelp: '두 단장이 합의한 거래예요. 승인하면 트레이드가 기록되고 2K 체크리스트에 올라가요.',
  approve: '승인',
  decline: '거절',
  confirmDecline: '이 거래를 거절할까요? 기록은 남아요.',
  approved: '승인했어요. 트레이드가 기록됐어요.',
  approveFailed: '그사이 규칙상 할 수 없게 돼서 기록하지 못했어요.',

  tabs: { log: '협상 기록', draft: '드래프트', gms: '단장들' } as Record<string, string>,
  draftEmpty: '이번 시즌 드래프트에서 AI 단장이 내린 결정이 아직 없어요.',
  draftKinds: { protect: '보호', swap: '지명', pass: '패스' } as Record<string, string>,
  draftSwap: (own: string, target: string, from: string) => `${own} 내주고 ← ${target} (${from}) 데려옴`,
  draftProtect: (player: string) => `${player} 보호`,
  draftNoProtect: '보호하지 않음',
  draftWorking: 'AI 단장들이 드래프트에서 움직이는 중…',
  draftWaiting: (team: string) => `지금은 ${team} 차례예요 (직접 운영하는 학교). 지명하거나 패스하면 AI 단장들이 이어서 움직여요.`,
  draftProtectDone: 'AI 단장들이 보호를 마쳤어요. 보호를 마감하면 지명이 시작되고, AI 단장들이 차례대로 지명해요.',
  draftWhy: '단장들의 속마음은 단장실 → 드래프트에서 볼 수 있어요.',
  draftNudge: 'AI 단장 이어서 움직이기',
  draftCodeTurns: 'Claude 없이 AI 차례 진행 (코드가 지명)',
  noWindows: '아직 트레이드 창이 열린 적이 없어요.',
  windowTitle: (round: number | null, name: RoundName = R) => (round !== null ? `${name(round)} 이후 트레이드 창` : '직접 연 트레이드 창'),
  windowCounts: (trades: number, talks: number) => `성사 ${trades} · 협상 ${talks}`,
  hidden: '창이 닫힐 때까지 협상 내용은 비공개예요 (편집실 → 단장 설정).',
  noTalks: '이 창에서는 협상이 없었어요.',
  statuses: { open: '협상 중', agreed: '승인 대기', accepted: '성사', rejected: '결렬', failed: '무산', declined: '커미셔너 거절' } as Record<string, string>,
  vetoed: '거부권 발동',
  lopsided: '사기 트레이드?',
  gap: (n: number) => `가치 차이 ${n > 0 ? '+' : ''}${n}`,
  sends: (team: string) => `${team} 보냄`,
  actions: { offer: '제안', counter: '역제안', accept: '수락', reject: '거절' } as Record<string, string>,
  note: '속마음',
  showNotes: '속마음 보기',
  report: (before: number, after: number, gain: number, cardsIn = 0, cardsOut = 0) =>
    `전력 ${before} → ${after} · 받는 가치 ${gain > 0 ? '+' : ''}${gain}${cardsIn || cardsOut ? ` · 카드 가치 들어옴 ${cardsIn}, 나감 ${cardsOut}` : ''}`,
  /** The rest of what the GM saw: where its team stood, its draft protection and roles after the deal, a counter against its ask, the early-season bar. */
  reportMore: (r: ReportMore, player: (id: string) => string) =>
    [
      r.stance ? `우리 팀 ${STANCES[r.stance] ?? r.stance}` : '',
      r.draft ? `드래프트 예상 카드 ${r.draft.cards === r.draft.cardsAfter ? `${r.draft.cards}장` : `${r.draft.cards} → ${r.draft.cardsAfter}장`}${r.draft.exposed.length ? ` · 못 지키는 선수: ${r.draft.exposed.map(player).join(', ')}` : ''}` : '',
      ...(r.rolesLost ?? []).map((x) => `이 거래 뒤 ${ROLES[x] ?? x} ${x === 'shooter' ? '부족' : '없음'}`),
      ...(r.rolesFilled ?? []).map((x) => `빈자리 채움: ${ROLES[x] ?? x}`),
      r.versusAsk && r.versusAsk.dropped.length
        ? `원했던 ${r.versusAsk.dropped.map(player).join(', ')} 대신 ${r.versusAsk.added.map(player).join(', ') || '없이'}: 가치 ${signed(r.versusAsk.value)}, 전력 ${signed(r.versusAsk.strength)}`
        : r.versusAsk
          ? `원안보다 가치 ${signed(r.versusAsk.value)}, 전력 ${signed(r.versusAsk.strength)}`
          : '',
      r.bar ? `시즌 초반: 효용 ${r.bar} 이상이어야 확실한 거래` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  trust: (n: number) => `신뢰 ${n > 0 ? '+' : ''}${n}`,
  reasons: { stalled: '응답이 오지 않아 무산됐어요.', expired: '시즌이 바뀌어 승인 기회가 지났어요.', control: '그사이 학교 운영이 바뀌어 무산됐어요.' } as Record<string, string>,
  ruleFailed: (codes: string) => `규칙에 막혀 무산됐어요 (${codes}).`,
  toTrades: '트레이드 기록',
  veto: '거부권',
  confirmVeto: '이 트레이드에 거부권을 쓸까요? 선수와 카드가 원래 팀으로 돌아가요.',

  gmName: (school: string) => `${school} 단장`,
  philosophies: { 'win-now': '당장 우승', balanced: '균형', development: '육성' } as Record<string, string>,
  negotiations: { fair: '공정', hardball: '강경', bluffer: '허세', pushover: '호구' } as Record<string, string>,
  stances: { buy: '보강', sell: '정리', hold: '관망' } as Record<string, string>,
  plan: '계획',
  quote: '공개 발언',
  targets: '노리는 선수',
  untouchables: '절대 안 보냄',
  trustTitle: '다른 단장에 대한 신뢰',
  noPlan: '아직 트레이드 창에서 움직인 적이 없어요.',
  inactive: '트레이드 안 함',
  editLore: '단장 로어',
  noLoreName: '이름 없음 (로어에서 정하거나 AI 초안으로)',

  // 편집실
  settingsTitle: '단장 설정',
  settingsHelp: '트레이드 창이 언제 열리고, AI 단장이 얼마나 자유롭게 움직일지 정해요.',
  windowMode: '트레이드 창 여는 방법',
  windowModes: { auto: '일정마다 자동으로', manual: '직접 열 때만' } as Record<'auto' | 'manual', string>,
  windowModeHelp: '직접 열 때만으로 두면 단장실의 "지금 트레이드 창 열기"를 누를 때만 AI 단장들이 움직여요.',
  dealCards: 'AI 제안 한쪽에 넣는 카드 최대 장수',
  dealCardsHelp: '스타 트레이드의 "선수 + 카드" 묶음 크기예요. 시즌 중 카드 트레이드 제한(리그 설정 → 트레이드·드래프트)은 여기와 상관없이 지켜요.',
  dealCardsNoLimit: '제한 없음',
  gmsPerWindow: '창마다 움직이는 단장 수',
  gmsPerWindowHelp: '의욕이 큰 순서로. 4명당 Claude 1번.',
  talksPerWindow: '창마다 협상 수',
  talksPerWindowHelp: '협상 하나에 Claude 1~2번.',
  earlyCaution: '시즌 초반에는 신중하게',
  earlyCautionHelp:
    '정규시즌 경기의 20%를 치르기 전까지는 AI 단장들이 덜 움직이고, 확실히 좋은 거래만 해요. 몇 경기로 팀을 판단하지 않는 실제 단장처럼요. 35%까지 차차 보통으로 돌아오고, 라운드든 2K 일정대로든 치른 경기 수로 따져요. 트레이드 마감 같은 기능은 아니에요. 끄면 시즌 내내 똑같이 움직여요.',
  save: '저장',
  saved: '저장했어요.',
  undo: '되돌리기',
}
