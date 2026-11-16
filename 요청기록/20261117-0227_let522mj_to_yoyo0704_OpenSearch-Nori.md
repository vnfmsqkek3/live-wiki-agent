# let522mj → yoyo0704 : KB OpenSearch 인덱스에 한국어 분석기 Nori 적용 (사용자 요청)

| 항목 | 내용 |
|---|---|
| 상태 | OPEN |
| 사용자 요청 (11/17) | OpenSearch에 Nori 플러그인 추가. 예: "전세 사기" 검색 |
| 대상 | `hanaeum-terraform/modules/kb/index-mapping.json` (KB 벡터 인덱스, AOSS `hanaeum-mvp-aoss-kb-dev`) |
| 처리 결과 | |

## 근거 (let522mj 검토)
- 현재 `text` 필드는 기본 분석기(standard)라 한국어 **조사를 떼지 못함**: "전세사기를" ≠ "전세사기", 붙여 쓴 "전세사기" ≠ 띄어 쓴 "전세 사기". 하이브리드 검색의 키워드(BM25) 쪽이 한국어에서 약함.
- Nori는 복합명사를 나누는 분석기다(띄어 쓴 "전세 사기"는 지금도 두 단어). 그래서 **`decompound_mode: mixed`** 로 원형("전세사기")과 분해형("전세"·"사기")을 함께 색인해 붙여 쓰기·띄어 쓰기 모두 맞고, 원형이 맞으면 점수가 더 높게 한다.
- 의미가 다른 문서("보험사기")가 키워드로만 맞는 경우는 벡터 검색 + Rerank + 관련도 판정(1위 게이트·비율)이 뒤로 민다(추정 → 도입 전후 측정으로 확인).

## 요청
1. **AOSS의 Nori 지원 여부를 AWS 문서로 확인** (지원 분석기 목록). 미지원이면 대안(검색 전 질의·청크에 형태소 분리 텍스트 필드를 추가하는 방식)을 let522mj와 상의
2. 지원하면 인덱스 settings에 분석기 추가, `text` 필드에 적용:
```json
"settings": { "index": { "knn": true, "knn.algo_param.ef_search": 512 },
  "analysis": {
    "tokenizer": { "ko_tok": { "type": "nori_tokenizer", "decompound_mode": "mixed" } },
    "analyzer": { "ko": { "type": "custom", "tokenizer": "ko_tok",
      "filter": ["nori_part_of_speech", "nori_readingform", "lowercase"] } } } },
"mappings": { "properties": { "text": { "type": "text", "analyzer": "ko" } } }
```
   (`nori_part_of_speech` 기본값이 조사·어미·기호 제거)
3. 분석기는 기존 인덱스에 바꿀 수 없음 → **인덱스 재생성 + legal·knowledge 데이터 소스 재색인**. 시각을 공통기록에 예고. 재색인 뒤 let522mj가 `measure-kb`(정확 조문·근거 인용·노출·단정 0)와 Nori 전후 비교 질의("전세사기를", "담보인정비율을" 등 조사 붙은 질의)로 확인
