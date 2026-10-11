---
# 새 선수 파일이 필요하면: 이 파일을 복사해서 teams/학교/ 폴더에 선수 이름으로 저장
# 동명이인은 원래 학교를 괄호로: 김철수(A고).md
id: 선수이름
traits:              # 1(낮음) ~ 5(높음)
  ego: 3             # 자존심, 대우받고 싶은 마음
  usage: 3           # 볼 욕심: 슛·공격 기회를 원하는 정도
  competitiveness: 3 # 승부욕
  loyalty: 3         # 학교·팀에 대한 애정
  temperament: 3     # 감정 기복 (높을수록 쉽게 폭발)
  professionalism: 3 # 프로 의식 (높을수록 빨리 회복)
  ambition: 3        # 에이스가 되고 싶은 마음, 기록 욕심
media: normal        # quiet / normal / outspoken
relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요
  # - with: 이순신
  #   type: rival          # friend / rival / family / mentor / dislikes
  #   strength: 4          # 1 ~ 5
  #   visibility: public   # public(공개) / rumor(소문) / secret(비밀)
hooks:               # 나만의 규칙 (선택)
  # - when: rival_award    # 라이벌이 상을 받으면
  #   rival: 이순신
  #   mood: { rivalry: -15 }
  # - when: traded         # 트레이드되면
  #   mood: { stability: -30 }
canon: true          # false로 바꾸면 AI가 자유롭게 살을 붙여도 됨
---

# 선수이름

## 공개
<!-- 누구나 아는 이야기: 별명의 유래, 플레이 스타일, 출신, 성격… -->

## 소문
<!-- 팬들 사이에서 도는 이야기. 사실일 수도, 아닐 수도. -->

## 비밀
<!-- 본인만 아는 이야기. 공개되기 전까지는 어떤 글에도 나오지 않고, 선수의 기분과 반응에만 영향을 줌. -->
