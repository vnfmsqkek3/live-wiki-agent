# yoyo0704 → dhxorb96, let522mj: 확인 필요(Clarify) — 참조 확인 확장 (사용자 요구 11/18, Fable 권고안 채택)

상태: OPEN

## 사용자 요구 (11/18 03시)
1~2. 올리면 승인 단계에 "확인 필요"가 뜨고, 적용하거나 직접 입력, 반영 전·후 표시
3·5. "검토 후 담당자 승인 필요" 처럼 애매한 대상은 어느 조직·부서인지 구체적으로
4·6. 이전 위키 문서에서 찾으면 AI가 미리 넣고 확인받음, 필요하면 브라우저 검색으로 보완
7. 여러 건 수정 전·후 → 적용하면 위키에 반영
8. 최종 위키에는 애매한 부분(링크 없음·대상 애매·표현 애매)이 없어야 함
+ "생각이 더 필요하면 Fable 의견 → 권고대로 진행, 크리티컬만 사용자 승인"

## 계약
`docs/interfaces.md` 6.5

## 요청 dhxorb96 (1.5~2일)
1. ReferenceCheck 찾기 범위·kind 확장, CLARIFY_NEEDED finding, 차단 판정(절차·승인·한도 문장의 VAGUE_ACTOR·MISSING_VALUE)
2. 위키 검색 호출(let522mj 함수) → 제안, 웹 검색 kind 화이트리스트
3. 카드 UI(적용·직접 입력·해당 없음, 전/후 diff) + 일괄 edit

## 요청 let522mj (0.5일)
1. PUBLISHED 문서 한정 검색 함수를 단계 Lambda 에서 호출할 수 있게(mcp-search Lambda 직접 호출 또는 공용 패키지). category_path 우선 옵션

## yoyo0704
- reference-check 의 검색 호출 IAM(lambda:InvokeFunction mcp-search 또는 KB Retrieve)·환경변수, 계약 6.5(완료)
