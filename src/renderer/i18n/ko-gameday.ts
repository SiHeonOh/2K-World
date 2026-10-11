/** 경기일's confirm screen and its checks before a read: spread into ko.gameday. */

type P = Record<string, string | number>

const STAGES: Record<string, string> = { regular: '정규시즌', 'play-in': '플레이-인', playoffs: '플레이오프', finals: '결승' }

/** "3라운드" (or, given `name`, "3일차" in 2K 일정대로) for a regular-season game, "플레이오프 2차전" for a playoff one. */
export const gameLabel = (stage: string, round: number, name: (n: number) => string = (n) => `${n}라운드`) =>
  stage === 'regular' ? name(round) : `${STAGES[stage] ?? stage} ${round}차전`

export const gamedayText = {
  gameLabel,
  // Before a read: the 2K checklist would block recording anyway, so no read is spent.
  blocked2k: (teams: string) => `${teams}에 2K에 아직 적용하지 않은 이동이 있어요. 인박스에서 2K 적용을 끝내야 이 경기를 기록할 수 있어서, 그 전에는 읽기를 시작하지 않아요.`,
  toInbox: '인박스로',
  waiting2kShort: '2K 적용 대기',

  // The final score.
  finalHelp: '스크린샷에 팀 합계나 최종 점수가 보이면 그 점수를, 아니면 선수 득점 합을 넣어 뒀어요. 다르면 고치세요.',
  scoreFrom: { shown: '스크린샷 합계', rows: '선수 득점 합', typed: '직접 입력' },
  resetScore: '되돌리기',
  wins: (team: string) => `${team} 승`,
  rowsSum: (n: number) => `선수 합 ${n}`,
  shownTotal: (n: number) => `스크린샷 합계 ${n}`,
  scoreLabel: (team: string) => `${team} 최종 점수`,

  // A guessed name is remembered for later games once saved, so each one is checked first.
  nameOk: '맞아요',
  nameOkHelp: '추측한 선수가 맞으면 체크하세요. 저장하면 이 2K 이름을 다음 경기부터 이 선수로 기억해요.',
  unchecked: (n: number) =>
    `추측한 이름 ${n}개를 아직 확인하지 않았어요. 맞으면 "맞아요"에 체크하고, 아니면 목록에서 맞는 선수를 고르세요. 저장한 이름은 다음 경기부터 기억해요.`,

  // The screenshots beside the tables.
  shotsTitle: '스크린샷',
  shotsHelp: '눌러서 크게 보기',
  shotAlt: (n: number) => `읽은 스크린샷 ${n}`,
  closeShot: '닫기',

  // What to look at before saving (the same checks run again after saving).
  checksTitle: '저장하기 전에 확인하세요',
  issues: {
    'line-points': (p: { team: string; source: string; points: number; expected: number }) =>
      `${p.team} · ${p.source}: 득점 ${p.points}점인데 슈팅 기록으로는 ${p.expected}점이에요`,
    'made-over-attempts': (p: { team: string; source: string; column: string }) => `${p.team} · ${p.source}: ${p.column} 성공이 시도보다 많아요`,
    'shown-total': (p: { team: string; rows: number; shown: number }) =>
      `${p.team}: 스크린샷의 팀 합계는 ${p.shown}점인데 선수 줄을 더하면 ${p.rows}점이에요. 잘린 줄이나 잘못 읽은 숫자가 없는지 보세요`,
    'final-vs-rows': (p: { team: string; rows: number; score: number }) => `${p.team}: 최종 점수 ${p.score}점, 선수 득점 합 ${p.rows}점`,
    'winner-differs': (p: { winner: string; loser: string; home: string; away: string; homeRows: number; awayRows: number }) =>
      `최종 점수로는 ${p.winner} 승인데, 선수 득점 합(${p.home} ${p.homeRows} : ${p.awayRows} ${p.away})으로는 ${p.loser} 승이에요. 스크린샷이 잘려 줄이 빠지지 않았는지 꼭 확인하세요`,
  },

  // The same screenshots read for another game.
  usedRecorded: (game: string) => `이 스크린샷은 이미 기록된 다른 경기(${game})의 박스스코어예요. 이 경기에는 기록할 수 없어요. 그 경기를 잘못 기록했다면 일정·결과에서 그 경기를 기록 취소한 뒤 저장하세요.`,
  usedElsewhere: (game: string) => `같은 스크린샷을 다른 경기(${game})에서도 읽었어요. 이 경기가 맞는지 확인하세요.`,
}

export const gamedayRefusals: Record<string, (p: P) => string> = {
  'job-retried': () => '이 스크린샷은 이미 다시 읽었거나 다시 읽는 중이에요. 경기일에서 그 경기를 고르면 그 판독을 이어서 볼 수 있어요',
  'screenshot-recorded': (p: P) =>
    `이 스크린샷은 이미 기록된 다른 경기(${gameLabel(String(p.stage), Number(p.round))} · ${String(p.teams).replace(', ', ' vs ')})의 박스스코어예요. 다른 스크린샷을 넣거나, 그 경기를 잘못 기록했다면 일정·결과에서 기록 취소한 뒤 다시 읽으세요`,
}
