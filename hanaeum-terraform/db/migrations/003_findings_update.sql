-- replaceStepFindings 의 INSERT … ON CONFLICT (finding_id) DO UPDATE 에 UPDATE 권한 필요 (11/17 dev 실측: permission denied for table findings)
GRANT UPDATE ON findings TO hanaeum_app;
