-- 애플리케이션 사용자 hanaeum_app (Data API 가 app secret 으로 접속). 비밀번호는 db-migrate.sh 가 :app_password 로 넣는다 (파일·로그에 남지 않음)
-- 권한: 문서·검수·승인·피드백·초안 읽기/쓰기, 감사는 INSERT·SELECT 만, DDL 없음
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hanaeum_app') THEN
    CREATE ROLE hanaeum_app LOGIN;
  END IF;
END
$$;
--;
ALTER ROLE hanaeum_app WITH LOGIN PASSWORD :app_password;
--;
GRANT USAGE ON SCHEMA public TO hanaeum_app;
--;
GRANT SELECT, INSERT, UPDATE ON documents, approvals, feedback, drafts TO hanaeum_app;
--;
GRANT SELECT, INSERT, DELETE ON findings TO hanaeum_app;
--;
GRANT SELECT, INSERT ON audit_events TO hanaeum_app;
