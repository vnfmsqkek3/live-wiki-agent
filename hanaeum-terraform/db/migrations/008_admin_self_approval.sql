-- 관리자 자기 승인 허용 (사용자 결정 11/18 11시: "관리자가 올린 문서는 관리자 스스로 승인할 수 있게, MVP라서 상관없어").
-- 일반 결재자의 자기 승인은 계속 금지. 관리자(PLATFORM_OPERATOR) 자기 승인은 self_approved=true 로 표시해 감사에서 구분한다.
-- ponytail: 실제 은행 운영에서는 이 마이그레이션을 되돌려 approvals_no_self_approval 원래 조건으로 복귀해야 한다
ALTER TABLE approvals ADD COLUMN self_approved boolean NOT NULL DEFAULT false;
--;
ALTER TABLE approvals DROP CONSTRAINT approvals_no_self_approval;
--;
ALTER TABLE approvals ADD CONSTRAINT approvals_no_self_approval CHECK (approver_sub IS NULL OR approver_sub <> author_sub OR self_approved);
