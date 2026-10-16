/** 리그 설정: changing a league's teams and rules after it exists (merged into ko as `leagueSettings`; its refusals into `rules`). */

type P = Record<string, string | number>

const SECTIONS = {
  teams: '팀 이름·색',
  control: '팀 운영',
  awards: '시상',
  trades: '트레이드 규칙',
  labels: '능력치 이름',
  roster: '로스터 규칙',
  playoffs: '플레이오프·순위 결정',
  draft: '드래프트',
  structure: '구조',
  schedule: '일정',
} as Record<string, string>

/** "드래프트: " before a refusal that names its section. */
const of = (p: P) => (typeof p.section === 'string' && SECTIONS[p.section] ? `${SECTIONS[p.section]}: ` : '')

export const leagueSettingsText = {
  title: '리그 설정',
  intro: '리그를 만든 뒤에도 팀, 구조, 일정, 플레이오프, 로스터 규칙, 시상, 트레이드, 드래프트, 능력치 이름을 고칠 수 있어요. 시즌의 시기에 따라 지금 바꿀 수 없는 항목은 잠겨 있고, 언제 바꿀 수 있는지 함께 알려 줘요. 저장할 때마다 리그 백업을 먼저 남겨요.',
  editRoomTitle: '리그 설정',
  editRoomHelp: '팀 이름과 운영(AI 단장·직접·동결), 구조, 일정, 플레이오프, 로스터 규칙, 시상, 트레이드 규칙, 드래프트, 능력치의 한국어 이름을 리그를 만든 뒤에도 바꿔요. 시즌의 시기에 따라 잠기는 항목이 있어요.',
  open: '리그 설정 열기',
  back: '편집실로',
  phaseNow: (phase: string) => `지금 시기: ${phase}`,
  when: '언제 바꿀 수 있나요',
  sections: SECTIONS,
  rulesText: {
    teams: '언제든 (표시 이름을 바꾸면 그 학교의 로어 폴더와 파일 이름도 따라 바뀌어요)',
    control: 'AI 단장 ↔ 직접은 언제든. 동결은 드래프트 중에만 빼고 언제든',
    awards: '언제든. 이미 준 상은 지울 수 없고, 준 기록이 들어맞게만 바꿀 수 있어요 (이름은 언제든)',
    trades: '언제든 (플레이오프 중에는 규칙과 상관없이 모든 선수가 묶여요)',
    labels: '언제든 (화면과 AI 글에 보이는 이름만 바뀌어요)',
    roster: '드래프트 중만 빼고 언제든. 지금 로스터가 새 규칙에 맞아야 해요',
    playoffs: '플레이오프가 시작되기 전까지 (시즌 전·정규시즌)',
    draft: '드래프트 중만 빼고 언제든. 방식(없음·카드 스왑)은 시즌 전이나 비시즌에만',
    structure: '시즌 전(일정이 만들어지기 전)이나 비시즌',
    schedule: '시즌 전(일정이 만들어지기 전)에만. 정규시즌 중에도 2K 일정대로로는 바꿀 수 있어요 (짜 놓고 안 한 경기가 없을 때)',
  } as Record<string, string>,
  openNow: '지금 바꿀 수 있음',
  locked: '지금은 잠김',
  freezeLocked: '동결만 잠김 (드래프트 중)',
  freezeNote: '드래프트가 진행 중이라 동결은 바꿀 수 없어요. AI 단장과 직접 운영은 지금도 바꿀 수 있어요.',
  edited: '바뀜',
  confirmRename: '표시 이름을 바꾸면 그 학교의 로어 폴더와 파일 이름도 따라 바뀌어요 (내용은 그대로예요). 저장할까요?',
  save: '설정 저장',
  saving: '저장 중…',
  undo: '되돌리기',
  confirmUndo: '저장하지 않은 변경을 모두 버릴까요?',
  changed: (sections: string) => `바뀐 항목: ${sections}`,
  nothing: '바뀐 것이 없어요.',
  blockedErrors: '빨간 항목을 고쳐야 저장할 수 있어요.',
  blockedLocked: (sections: string) => `지금은 바꿀 수 없는 항목이 바뀌었어요: ${sections}. 되돌린 뒤 저장해 주세요.`,
  confirm: (sections: string) => `${sections}을(를) 저장할까요? 저장 전 리그를 백업해 둬요.`,
  saved: (version: number | null) =>
    version === null ? '저장했어요. 저장 전 리그는 백업에 남아 있어요.' : `저장했어요 (설정 버전 ${version}). 저장 전 리그는 백업에 남아 있어요.`,
  renamed: (from: string, to: string) => `${from} → ${to}: 로어 폴더와 파일 이름도 바꿨어요 (내용은 그대로예요).`,
  wikiNote: (n: number) => `위키의 학교 문서 제목은 그대로예요(다른 문서의 링크가 끊기지 않게). 선수 문서 ${n}곳의 학교 분류를 새 이름으로 바꿨어요.`,
  cardsAdded: (n: number) => `새 배분에 맞춰 카드 ${n}장을 더 나눠 줬어요.`,
  cardsExpired: (n: number) => `카드 드래프트를 꺼서 남아 있던 카드 ${n}장이 소멸했어요.`,
  confirmCardsExpire: (n: number) =>
    `카드 드래프트를 끄면 아직 남아 있는 카드 ${n}장이 소멸해요. 다시 켜도 돌아오지 않아요. 저장 직전 리그를 새로 백업해 두니, 되돌리려면 백업과 복원에서 복원하면 돼요. 저장할까요?`,
  team: {
    title: '팀',
    help: '정식 이름, 표시 이름, 색, 운영은 언제든 바꿀 수 있어요. 디비전은 구조를 바꿀 수 있을 때만 바꿔요.',
    name: '정식 이름',
    shortName: '표시 이름',
    colors: '색',
    addColor: '+ 색',
    removeColor: '이 색 빼기',
    division: '디비전',
    control: '운영',
    frozenLocked: '드래프트 중에는 동결을 풀 수 없어요',
  },
  givenAward: '이미 준 상이에요. 지울 수 없고, 준 기록에 맞게만 바꿀 수 있어요.',
  oncePerSeasonTip:
    '시즌 중 한 번 트레이드된 선수를 드래프트까지 다시 트레이드하지 못하게 하려면 "한 번 트레이드된 선수는 다시 트레이드 불가"를 켜고 "드래프트까지"를 고르세요.',
  issuedCards: (n: number) => `이번 시즌 팀마다 카드 ${n}장을 이미 나눠 줬어요. 가장 적게 받는 순위의 카드를 ${n}장보다 줄일 수 없고, 늘리면 바로 더 나눠 줘요.`,
  draftKindLocked: '드래프트 방식(없음·카드 스왑)은 시즌 전이나 비시즌에만 바꿀 수 있어요.',
  rules: {
    'settings-teams-fixed': () => '팀을 더하거나 뺄 수는 없어요. 화면을 다시 불러온 뒤 저장해 주세요',
    'settings-during-draft': (p: P) => `${of(p)}드래프트가 진행 중이라 바꿀 수 없어요. 드래프트를 마친 뒤(비시즌)에 바꿀 수 있어요`,
    'settings-playoffs-started': (p: P) =>
      p.phase === 'playoffs'
        ? `${of(p)}플레이오프가 시작돼서 바꿀 수 없어요. 다음 시즌을 시작한 뒤(시즌 전)에 바꿀 수 있어요`
        : `${of(p)}이번 시즌 플레이오프는 이미 끝났어요. 다음 시즌을 시작한 뒤(시즌 전)에 바꿀 수 있어요`,
    'settings-season-running': (p: P) => `${of(p)}시즌이 진행 중이라 바꿀 수 없어요. 시즌 전(일정이 만들어지기 전)이나 비시즌에 바꿀 수 있어요`,
    'settings-schedule-next': (p: P) => `${of(p)}비시즌에 바꾸면 방금 끝난 시즌의 경기 수가 달라져요. 다음 시즌을 시작한 뒤(시즌 전)에 바꿔 주세요`,
    'settings-draft-kind': () => '드래프트 방식(없음·카드 스왑)은 시즌 전이나 비시즌에만 바꿀 수 있어요',
    'settings-cards-issued': (p: P) => `이번 시즌 팀마다 카드 ${p.count}장을 이미 나눠 줬어요. 가장 적게 받는 순위의 카드를 ${p.count}장보다 줄일 수 없어요`,
    'settings-award-given': (p: P) => `'${p.award}'은(는) 이미 준 상이라 지울 수 없어요. 이름은 바꿀 수 있어요`,
    'settings-award-shape': (p: P) => `'${p.award}'은(는) 이미 준 기록이 새 설정(팀 수·인원·주기·대상)에 맞지 않아요. 이름은 바꿀 수 있어요`,
    'settings-freeze-cards': (p: P) =>
      `${p.team}은(는) 이번 시즌 다른 팀과 카드를 주고받아서 동결할 수 없어요 (동결된 팀은 드래프트에서 빠져 그 카드를 쓸 수 없어요). 카드 트레이드를 되돌린 뒤 동결해 주세요`,
    'settings-team-name-player': (p: P) => `'${p.name}'은(는) 선수 이름과 같아서 학교 표시 이름으로 쓸 수 없어요 (로어 파일 이름이 겹쳐요)`,
    'settings-team-lore-taken': (p: P) => `'${p.name}'(으)로 바꾸면 로어가 ${p.path} 자리에 가야 하는데, 이미 있어요. 그 폴더나 파일을 정리한 뒤 다시 저장해 주세요`,
    'settings-team-lore-locked': () =>
      '로어 폴더나 파일을 옮기지 못해서 저장하지 않았어요. 다른 프로그램(편집기, Obsidian 등)이 열고 있는지 확인한 뒤 다시 저장해 주세요',
  } as Record<string, (p: P) => string>,
}
