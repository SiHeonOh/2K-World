import { rng } from '@core/random'
import type { StoryInput, StoryKind, StoryOutput } from './jobs'

/**
 * Stand-in writing for demo mode and tests: canned community lines filled
 * with the job's own names, so every screen works without Claude. Its only
 * numbers come from the job's facts (or are ones the number check skips),
 * so a demo run never needs a retry.
 */

export interface DemoFacts {
  fans: string[]
  reporters: string[]
  /** Boards a post may go to (not 포텐). */
  boards: string[]
  /** e.g. "가람고 78 : 72 누리고", or the news text. */
  headline: string
  teams: string[]
  names: string[]
  /** Active threads chatter may comment on. */
  postIds: number[]
  /** What you wrote, for replies. */
  userText?: string
  /** A chatter batch's poll topic (question and options), when its plan has one. */
  poll?: { question: string; options: string[] }
}

const REACTIONS = [
  '{name} 오늘 미쳤네 ㄹㅇ',
  '{team} 수비 왜 저럼 ㅋㅋㅋ',
  '이 경기 직관한 사람? 분위기 장난 아니었음',
  '{name} MVP 각 아님?',
  '솔직히 {team} 운빨 반 실력 반',
  '4쿼터 그 장면 아직도 소름',
  'ㅇㅈ 이건 인정해야 함',
  '{team} 팬인데 오늘은 할 말이 없다',
  '다음 경기는 {team}이 이긴다 내가 장담함',
  '감독 작전타임 타이밍 실화냐',
  '{name} 3점슛 들어갈 때 소리 지름 ㅋㅋ',
  '아니 근데 심판 콜 좀 이상하지 않았음?',
]
const REPLIES = ['ㄹㅇㅋㅋ', '그건 아니지', '인정합니다', '뭔 소리야 ㅋㅋㅋ', '이분 뭘 좀 아시네', '반박 불가', '그건 좀 억까 아님?']
const CHATTER_TITLES = [
  '{team} 이번 시즌 몇 위 예상함?',
  '{name} vs 다른 에이스 누가 위임?',
  '진지하게 리그 왕은 누구냐',
  '[투표] 이번 라운드 MVP',
  '뉴비인데 {team} 응원해도 됨?',
  '{team} 트레이드 하나만 하면 우승각인데',
  '오늘 급식 메뉴보다 {team} 경기가 더 궁금함',
  '라떼는 {team} 이 정도 아니었는데',
]

const fill = (template: string, random: () => number, facts: DemoFacts) => {
  const pick = (items: string[], fallback: string) => (items.length ? items[Math.floor(random() * items.length)]! : fallback)
  return template.replace('{name}', pick(facts.names, '에이스')).replace('{team}', pick(facts.teams, '우리 학교'))
}

export function demoOutput(kind: StoryKind, input: StoryInput): StoryOutput {
  const facts = input.demo
  const random = rng(`${kind}:${facts.headline}:${facts.userText ?? ''}:${input.asOfEvent}`)
  const fan = () => (facts.fans.length ? facts.fans[Math.floor(random() * facts.fans.length)]! : 'f001')
  const board = () => (facts.boards.length ? facts.boards[Math.floor(random() * facts.boards.length)]! : input.board)
  const comments = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i > 0 && random() < 0.3
        ? { author: fan(), body: REPLIES[Math.floor(random() * REPLIES.length)]!, reply: i - 1 }
        : { author: fan(), body: fill(REACTIONS[Math.floor(random() * REACTIONS.length)]!, random, facts) },
    )

  switch (kind) {
    case 'post_game_thread':
      return {
        posts: [
          { board: input.board, author: fan(), tag: '경기', title: `[경기 후] ${facts.headline}`, body: `${facts.headline}\n\n다들 어떻게 봤음?`, heat: 3, comments: comments(14) },
          ...(facts.reporters.length
            ? [{ board: input.board, author: facts.reporters[0]!, tag: '기사', title: `${facts.headline}… ${facts.names[0] ?? '에이스'} 활약`, body: `${facts.headline}. 경기 내용을 정리했다.`, heat: 2, comments: comments(4) }]
            : []),
        ],
        replies: [],
        memories: facts.teams.length ? [{ author: fan(), note: `${facts.teams[0]} 이번 시즌 4강 간다고 함` }] : [],
      }
    case 'event_thread':
      return {
        posts: [
          ...(facts.reporters.length
            ? [{ board: input.board, author: facts.reporters[0]!, tag: '오피셜', title: facts.headline, body: `${facts.headline}\n\n자세한 내용은 추후 전한다.`, heat: 3, comments: comments(5) }]
            : []),
          { board: input.board, author: fan(), tag: null, title: `${facts.headline} 이거 어떻게 봄?`, body: '반응 궁금하다', heat: 3, comments: comments(12) },
        ],
        replies: [],
        memories: [],
      }
    case 'reply_to_user':
      return {
        posts: [],
        replies: [
          {
            postId: input.postId ?? 0,
            replyTo: input.commentId ?? null,
            comments: [
              { author: fan(), body: facts.userText ? `"${facts.userText.slice(0, 20)}" 이거 ㄹㅇ 공감` : 'ㅋㅋㅋ 인정' },
              { author: fan(), body: '그건 좀 아닌 듯', reply: 0 },
              { author: fan(), body: fill('근데 {name} 얘기는 왜 없음?', random, facts) },
            ],
          },
        ],
        memories: [],
      }
    case 'live_comments':
      return { posts: [], replies: [{ postId: input.postId ?? 0, replyTo: null, comments: comments(6) }], memories: [] }
    case 'chatter_batch': {
      const posts: StoryOutput['posts'] = Array.from({ length: 8 }, () => ({
        board: board(),
        author: fan(),
        tag: null,
        title: fill(CHATTER_TITLES[Math.floor(random() * CHATTER_TITLES.length)]!, random, facts),
        body: fill('{team} 얘기 좀 해보자', random, facts),
        heat: 1 + Math.floor(random() * 3),
        comments: comments(2 + Math.floor(random() * 4)),
      }))
      // The first post carries a poll: the plan's poll topic, else an MVP vote over the names at hand, so demo runs always see one.
      const poll = facts.poll ?? (facts.names.length >= 2 ? { question: '이번 라운드 MVP는?', options: facts.names.slice(0, 4) } : null)
      if (poll) {
        posts.unshift({
          board: board(),
          author: fan(),
          tag: '투표',
          title: poll.question,
          body: '골라 봐라 ㅋㅋ 이유도 댓글로',
          heat: 3,
          comments: poll.options.slice(0, 3).map((o, i) => ({ author: fan(), body: `${i + 1}번 ${o} ㄱㄱ` })),
          poll,
        })
      }
      const replies = facts.postIds.slice(0, 6).map((postId) => ({ postId, replyTo: null, comments: comments(1 + Math.floor(random() * 3)) }))
      return { posts, replies, memories: [] }
    }
  }
}
