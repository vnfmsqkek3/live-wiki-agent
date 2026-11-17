-- 승인 1회 사용의 멱등 재시도 (let522mj 요청 11/17, interfaces 7.1): 같은 워크플로가 Promote 를 다시 부르면 USED+used_by=workflow_id 면 허용
ALTER TABLE approvals ADD COLUMN used_by text;
--;
ALTER TABLE approvals ADD COLUMN used_at timestamptz;
