-- 보관함 '검증한 사람' 표시 (dhxorb96 PR #18 리뷰 11/17: postgres 승인 시 column does not exist)
ALTER TABLE approvals ADD COLUMN approver_name text;
