-- 주장(Claim) 단위 지식 (사용자 결정 11/17: 얇은 버전 — 노하우 검증 결과를 주장으로 저장). 계약 interfaces.md 10.2.
-- 원본: 노하우 검증 items(statement·provision_id·relation·reason·quote·verified_quote). 새 추출 없음.
-- 문서 버전마다 doc_id 가 다르므로 주장은 doc_id 에 묶인다. 답변·집계는 documents.lifecycle='PUBLISHED' 인 문서의 주장만 쓴다.
-- ponytail: 중복 묶기(group_id·embedding)·적용 조건(condition)·Neptune CLAIM 노드는 칸만 열어 둠. 채우는 작업은 MVP 뒤
CREATE TABLE claims (
  claim_id      text PRIMARY KEY,                       -- {doc_id}#{순번}
  doc_id        text NOT NULL REFERENCES documents (doc_id),
  seq           integer NOT NULL,
  statement     text NOT NULL,                          -- 마스킹본 문장
  page          integer,                                -- 1부터. 모르면 NULL
  provision_id  text,                                   -- 근거 조문 (Trusted Registry). 없으면 NULL
  relation      text NOT NULL CHECK (relation IN ('SUPPORTS', 'SUPPLEMENTS', 'CONFLICTS', 'INSUFFICIENT', 'UNRELATED')),
  reason        text NOT NULL DEFAULT '',
  quote         text,                                   -- 조문 인용
  verified      boolean NOT NULL DEFAULT false,         -- 인용이 조문 원문과 대조 통과
  status        text NOT NULL DEFAULT 'CURRENT' CHECK (status IN ('CURRENT', 'REVIEW_REQUIRED', 'SUPERSEDED')),
  status_reason text,                                   -- 예: 'provision_revised:{new provision_id}'
  condition     text,                                   -- 적용 조건 (나중)
  group_id      text,                                   -- 같은 주장 묶음 (나중)
  embedding     vector(1024),                           -- 중복 묶기용 (나중)
  checked_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)
);
--;
CREATE INDEX claims_provision_idx ON claims (provision_id) WHERE provision_id IS NOT NULL;
--;
CREATE INDEX claims_doc_idx ON claims (doc_id);
--;
CREATE INDEX claims_attention_idx ON claims (status, relation);
--;
GRANT SELECT, INSERT, UPDATE ON claims TO hanaeum_app;
--;
-- 지식 부채 집계 (관리자 화면). 게시된 문서의 주장만
CREATE VIEW knowledge_debt AS
SELECT
  count(*) FILTER (WHERE c.relation = 'CONFLICTS')                         AS conflicts,
  count(*) FILTER (WHERE c.status = 'REVIEW_REQUIRED')                     AS review_required,
  count(*) FILTER (WHERE c.relation = 'INSUFFICIENT' OR NOT c.verified)    AS unverified,
  count(*) FILTER (WHERE c.relation IN ('SUPPORTS', 'SUPPLEMENTS') AND c.verified AND c.status = 'CURRENT') AS healthy,
  count(DISTINCT c.doc_id) FILTER (WHERE c.relation = 'CONFLICTS' OR c.status = 'REVIEW_REQUIRED') AS docs_needing_attention
FROM claims c JOIN documents d ON d.doc_id = c.doc_id
WHERE d.lifecycle = 'PUBLISHED';
--;
GRANT SELECT ON knowledge_debt TO hanaeum_app;
