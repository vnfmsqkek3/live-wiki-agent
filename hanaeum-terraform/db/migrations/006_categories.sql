-- 업무 분류 자동화 (사용자 결정 11/17 "A: 완전 자동"). AI 가 칸 배정·새 칸 생성·유사 칸 병합·주기 정리를 모두 하고, 모든 변경은 category_events 에 남긴다.
-- 문서 종류(REGULATION·KNOWHOW·MANUAL)는 검증 방식 축이라 그대로 두고, 탐색 축을 이 계층 분류로 둔다.
-- 유사 칸 판정: 이름+설명 임베딩(Titan v2, 1024) 코사인 유사도 (pgvector). 임베딩이 NULL 인 칸은 분류 단계가 처음 쓸 때 채운다.
CREATE EXTENSION IF NOT EXISTS vector;
--;
CREATE TABLE categories (
  category_id text PRIMARY KEY,
  parent_id   text REFERENCES categories (category_id),
  name        text NOT NULL,
  path        text NOT NULL UNIQUE, -- 예: 여신/기업여신
  level       smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  description text NOT NULL DEFAULT '',
  embedding   vector(1024),
  origin      text NOT NULL CHECK (origin IN ('SEED', 'AI', 'ADMIN')),
  merged_into text REFERENCES categories (category_id), -- 병합되면 대상 칸. 문서는 대상으로 옮긴다 (행은 기록용으로 남김)
  doc_count   integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, name)
);
--;
CREATE INDEX categories_parent_idx ON categories (parent_id) WHERE merged_into IS NULL;
--;
CREATE INDEX categories_embedding_idx ON categories USING hnsw (embedding vector_cosine_ops);
--;
-- 분류 변경 기록 (추가만): CREATE·MERGE·RENAME·ASSIGN(문서 배정)·REASSIGN(재분류)
CREATE TABLE category_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL, -- 'AI' 또는 사용자 sub
  action      text NOT NULL CHECK (action IN ('CREATE', 'MERGE', 'RENAME', 'ASSIGN', 'REASSIGN')),
  category_id text NOT NULL,
  target_id   text,          -- MERGE 대상 칸, ASSIGN·REASSIGN 의 doc_id
  detail      jsonb          -- 유사도·이유·이전 이름 등 (원문 금지)
);
--;
CREATE INDEX category_events_cat_idx ON category_events (category_id, at DESC);
--;
CREATE TRIGGER category_events_no_update_delete BEFORE UPDATE OR DELETE ON category_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--;
ALTER TABLE documents ADD COLUMN category_id text REFERENCES categories (category_id);
--;
CREATE INDEX documents_category_idx ON documents (category_id) WHERE category_id IS NOT NULL;
--;
GRANT SELECT, INSERT, UPDATE ON categories TO hanaeum_app;
--;
GRANT SELECT, INSERT ON category_events TO hanaeum_app;
--;
-- 초기 칸 (은행 업무 2단계). 이후 칸은 AI 가 만든다
INSERT INTO categories (category_id, parent_id, name, path, level, description, origin) VALUES
  ('cat_loan', NULL, '여신', '여신', 1, '대출·보증·담보·여신 심사와 사후관리', 'SEED'),
  ('cat_loan_corp', 'cat_loan', '기업여신', '여신/기업여신', 2, '기업 대출 심사·승인 한도·본부 승인', 'SEED'),
  ('cat_loan_retail', 'cat_loan', '가계여신', '여신/가계여신', 2, '개인 대출·주택담보대출·신용대출', 'SEED'),
  ('cat_loan_collateral', 'cat_loan', '담보·감정평가', '여신/담보·감정평가', 2, '부동산 담보 평가·감정·현장 실사', 'SEED'),
  ('cat_deposit', NULL, '수신', '수신', 1, '예금·적금·입출금·창구 업무', 'SEED'),
  ('cat_deposit_account', 'cat_deposit', '계좌·예적금', '수신/계좌·예적금', 2, '계좌 개설·해지·예금·적금 상품', 'SEED'),
  ('cat_deposit_cash', 'cat_deposit', '창구·현금', '수신/창구·현금', 2, '창구 입출금·고액 현금·ATM', 'SEED'),
  ('cat_fx', NULL, '외환', '외환', 1, '환전·해외송금·무역금융', 'SEED'),
  ('cat_fx_remit', 'cat_fx', '송금·환전', '외환/송금·환전', 2, '해외송금·환전·외화 예금', 'SEED'),
  ('cat_card', NULL, '카드', '카드', 1, '신용·체크카드 발급과 이용', 'SEED'),
  ('cat_invest', NULL, '신탁·펀드', '신탁·펀드', 1, '펀드·신탁·투자상품 판매', 'SEED'),
  ('cat_invest_sales', 'cat_invest', '상품 판매·설명', '신탁·펀드/상품 판매·설명', 2, '투자상품 적합성·설명 의무·판매 절차', 'SEED'),
  ('cat_risk', NULL, '리스크관리', '리스크관리', 1, '신용·시장·운영 리스크', 'SEED'),
  ('cat_compliance', NULL, '내부통제·준법', '내부통제·준법', 1, '내부통제·준법감시·자금세탁방지', 'SEED'),
  ('cat_compliance_aml', 'cat_compliance', '자금세탁방지', '내부통제·준법/자금세탁방지', 2, 'AML·고객확인·의심거래 보고', 'SEED'),
  ('cat_privacy', NULL, '개인정보·보안', '개인정보·보안', 1, '개인정보 보호·정보보안', 'SEED'),
  ('cat_privacy_pii', 'cat_privacy', '개인정보 보호', '개인정보·보안/개인정보 보호', 2, '개인정보 수집·이용·파기·마스킹', 'SEED'),
  ('cat_privacy_sec', 'cat_privacy', '정보보안', '개인정보·보안/정보보안', 2, '접근 통제·보안 사고 대응·망분리', 'SEED'),
  ('cat_it', NULL, '전산·IT', '전산·IT', 1, '업무 시스템·단말·네트워크 사용', 'SEED'),
  ('cat_it_system', 'cat_it', '업무 시스템', '전산·IT/업무 시스템', 2, '여신·수신 시스템 등 업무 프로그램 사용법', 'SEED'),
  ('cat_consumer', NULL, '민원·소비자보호', '민원·소비자보호', 1, '민원 처리·금융소비자 보호', 'SEED'),
  ('cat_admin', NULL, '경영지원', '경영지원', 1, '총무·시설·사무기기·구매', 'SEED'),
  ('cat_admin_office', 'cat_admin', '사무기기·시설', '경영지원/사무기기·시설', 2, '복합기·프린터·회의실·사옥 시설 안내', 'SEED'),
  ('cat_hr', NULL, '인사·교육', '인사·교육', 1, '인사 제도·근무·교육', 'SEED'),
  ('cat_etc', NULL, '기타', '기타', 1, '어느 칸에도 맞지 않는 문서 (정리 작업이 새 칸으로 옮김)', 'SEED');
--;
INSERT INTO category_events (actor, action, category_id, detail)
  SELECT 'SEED', 'CREATE', category_id, jsonb_build_object('path', path) FROM categories;
