---
version: 1
slug: "app"
primary_target: "app"
related_targets: []
---

# Surface: Hanaeum Wiki 앱 전체 (apps/web/app)

Mode: Operate. Build path: code-led.

## Scope
로그인·홈·검색·보관함 목록/상세·등록·검토·결재함·가이드. 사용자: 은행 실무자(찾아 쓰기)·결재자(승인·출처 검토). 1차 목적: 공모전 시연에서 두 흐름을 짧게 보여 주기.
피할 것(사용자): 작고 빽빽한 글자, 흔한 관리자 템플릿, 은행 업무용으로 가벼운 화려함, 무엇을 누를지 모름, 중요한 정보가 한눈에 안 들어옴. 시연용이라 시각 표현도 중요.
지킬 것(브랜드 약속): Hana 색·폰트, 흰 바탕, 한쪽 색 띠 금지, 상세는 한눈에 보기 + 제목 카드 팝업, 왼쪽 세로 메뉴·내용은 가로 배치, 목록 페이지네이션.

## Direction contract
THESIS: 문서의 신뢰 상태는 결재란과 도장으로 읽힌다. 작성·AI 검사·사람 승인 세 칸이 모든 문서에 있고, 승인 칸에 그린 도장이 찍혀야 '검증 완료'. 범주 기본값(배지 한 개 + 회색 카드 대시보드)을 거부한다.
OWN-WORLD: 흰 바탕, 네이비 #0A1C36 글자와 1.5px 결재란 괘선, 원형 도장 3종(그린 #00706B 승인·완료, 코랄 #C2410C 충돌·반려·차단, 점선 #B9C4D3 대기), 칸 테두리 1px #DCE3ED 한 체계, 조문 번호 바이올렛 #5B4BC4, 숫자 IBM Plex Mono. 제목 IBM Plex Sans KR, 본문 Pretendard.
STORY: 실무자는 결재란을 보고 믿어도 되는지 바로 알고 본문을 읽는다. 결재자는 비어 있는 칸(대기 도장)과 코랄 도장 이유를 눌러 판단하고 승인 도장을 찍는다.
FIRST VIEWPORT: 상세 기준. 왼쪽 세로 메뉴. 머리 왼쪽에 경로·제목·한 줄 상태 문장, 오른쪽에 결재란 3칸(작성·AI 검사·승인, 각 칸 도장). 그 아래 본문(쪽 본문, 밑줄) | 정보 목록(고칠 곳 수 코랄·시행일·버전·등록, 원본 다운로드 그린 버튼). 하단 제목 카드 가로 줄(고칠 곳·비교한 대상·버전·관련 문서·외부 법령) → 팝업. 그린 면은 주 행동 하나.
FORM: 결재란과 도장, 근거 목록 1순위(IMPECCABLE'S PICK, 사용자 선택). seed:45d95521fb70dc78. 서명 동작(signature move): 승인 순간 승인 칸에 도장이 찍히는 1회 모션(reduced-motion이면 즉시 표시). 결재함 카드·보관함 카드·검색 결과에도 작은 결재란(3점)으로 같은 신뢰 언어.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
