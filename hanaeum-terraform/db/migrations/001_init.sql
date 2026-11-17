-- 거버넌스 저장소 v1 (사용자 결정 11/17: DynamoDB documents·approvals·feedback·audit_events → PostgreSQL)
-- 남는 DynamoDB: workflows(단계 기록·실행 잠금), regulations(Trusted Registry), findings(미사용 예비)
-- 시각은 timestamptz, 상태값은 CHECK 로 packages/schemas enum 과 맞춘다. 자주 묻지 않는 필드는 attrs jsonb.

CREATE TABLE documents (
  doc_id                 text PRIMARY KEY CHECK (doc_id ~ '^doc_[0-9A-HJKMNP-TV-Z]{26}$'),
  version                integer NOT NULL CHECK (version >= 1),
  owner                  text NOT NULL,
  title                  text NOT NULL,
  dept                   text NOT NULL,
  acl_groups             text[] NOT NULL DEFAULT '{}',
  ext                    text NOT NULL,
  lifecycle              text NOT NULL CHECK (lifecycle IN ('QUARANTINED', 'IN_REVIEW', 'PENDING_APPROVAL', 'PUBLISHED', 'BLOCKED', 'DELETED')),
  document_type          text CHECK (document_type IN ('REGULATION', 'KNOWHOW', 'MANUAL')),
  authority_status       text NOT NULL CHECK (authority_status IN ('VERIFIED', 'UNVERIFIED', 'REJECTED')),
  freshness              text NOT NULL CHECK (freshness IN ('CURRENT', 'REVIEW_REQUIRED', 'SUPERSEDED')),
  trust_gate_result      text CHECK (trust_gate_result IN ('PASS', 'REVIEW_REQUIRED', 'QUARANTINED')),
  workflow_id            text,
  s3_version_id          text,
  content_hash           text,
  published_content_hash text,
  law_id                 text,
  revision_id            text,
  -- 나머지: classification, classification_history, citations, summary, page_summaries, knowhow_validation,
  -- freshness_reason, source_review, parse_reviewed, conditional, law_name, effective_from/to, deleted_* 등
  attrs                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL
);
--;
CREATE INDEX documents_owner_idx ON documents (owner, updated_at DESC);
--;
CREATE INDEX documents_lifecycle_idx ON documents (lifecycle, updated_at DESC);
--;
CREATE INDEX documents_law_idx ON documents (law_id) WHERE law_id IS NOT NULL;
--;
-- 검수 결과: 단계별 교체(DELETE step → INSERT)를 한 트랜잭션으로. 문서 행 잠금(SELECT … FOR UPDATE)으로 병렬 단계 직렬화
CREATE TABLE findings (
  finding_id text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES documents (doc_id) ON DELETE CASCADE,
  step       text NOT NULL,
  severity   text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  code       text NOT NULL,
  data       jsonb NOT NULL, -- message, evidence_ref, location, user_message, fix_hint, details
  created_at timestamptz NOT NULL DEFAULT now()
);
--;
CREATE INDEX findings_doc_idx ON findings (doc_id, step);
--;
CREATE TABLE approvals (
  approval_id   text PRIMARY KEY CHECK (approval_id ~ '^apr_[0-9A-HJKMNP-TV-Z]{26}$'),
  doc_id        text NOT NULL REFERENCES documents (doc_id),
  version       integer NOT NULL,
  s3_version_id text NOT NULL,
  content_hash  text NOT NULL,
  author_sub    text NOT NULL,
  approver_sub  text,
  status        text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'USED')),
  reason        text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL,
  CONSTRAINT approvals_no_self_approval CHECK (approver_sub IS NULL OR approver_sub <> author_sub),
  CONSTRAINT approvals_decided CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
--;
CREATE INDEX approvals_status_idx ON approvals (status, created_at);
--;
CREATE INDEX approvals_doc_idx ON approvals (doc_id, version);
--;
CREATE TABLE feedback (
  doc_id     text NOT NULL REFERENCES documents (doc_id),
  user_sub   text NOT NULL,
  stars      smallint CHECK (stars BETWEEN 1 AND 5),
  useful     boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (doc_id, user_sub)
);
--;
CREATE TABLE drafts (
  draft_id      text PRIMARY KEY,
  doc_id        text NOT NULL REFERENCES documents (doc_id),
  base_version  integer NOT NULL,
  proposed_text text NOT NULL,
  basis         text[] NOT NULL DEFAULT '{}',
  created_by    text NOT NULL,
  status        text NOT NULL CHECK (status = 'DRAFT'),
  created_at    timestamptz NOT NULL
);
--;
CREATE INDEX drafts_doc_idx ON drafts (doc_id, created_at);
--;
CREATE TABLE audit_events (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL,
  actor    text NOT NULL,
  action   text NOT NULL,
  resource text NOT NULL,
  result   text NOT NULL CHECK (result IN ('OK', 'DENIED')),
  trace_id text NOT NULL,
  detail   jsonb
);
--;
CREATE INDEX audit_events_at_idx ON audit_events (at DESC);
--;
CREATE INDEX audit_events_resource_idx ON audit_events (resource, at DESC);
--;
-- 감사 기록은 추가만: 수정·삭제는 소유자(마이그레이션)라도 트리거가 막는다
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
--;
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
