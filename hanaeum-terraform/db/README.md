# db

거버넌스 저장소(Aurora PostgreSQL) 스키마 마이그레이션. `migrations/NNN_이름.sql` 을 `scripts/db-migrate.sh` 가 번호 순서로 1회씩 적용한다 (terraform apply 가 실행).
문장 구분은 줄 하나에 `--;` 만. 이미 적용된 파일은 고치지 말고 새 번호로 추가한다.
