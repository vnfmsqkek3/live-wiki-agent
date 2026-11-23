평가 실행기 (Owner 인프라팀). `tests/evaluations/cases`의 측정 스크립트(오프라인 `measure.ts`, 실환경 `measure-kb.ts`)를 돌려 결과표를 만들고, S3 `evaluations/`와 감사 기록 `EVALUATION_RUN`(관리 > Agent 평가 화면)에 남긴다.

```bash
set -a; . ./.env.local; set +a          # HANAEUM_ENV=prod, prod 계정
node tests/evaluations/runner/src/run.ts            # 측정 + 저장
node tests/evaluations/runner/src/run.ts --dry-run  # 측정만 (S3·감사 기록 없음)
node tests/evaluations/runner/src/run.ts --extra extra.json  # 다른 팀 측정값을 같은 실행에 합쳐 저장
SEED_IDS=/절대경로/seed-doc-ids.json node tests/evaluations/runner/src/run.ts --extra extra.json  # prod 정식 실행
```

`SEED_IDS`: 데이터팀 시드 매핑(`{키: doc_id}`, Git 미추적. 총괄·데이터 `role/.state/seed-doc-ids.json`). measure-kb 가 시드 밖 문서(QA 업로드)를 빼고 잰다. prod 는 QA 문서가 섞이므로 정식 실행엔 항상 준다. 실행 전 데이터팀 시드 작업이 진행 중이 아닌지, 재시드된 키(F-002 등)가 새 doc_id 인지 확인 (11/23 경쟁 상태로 영향 2/3).

`--extra`: 실행기가 직접 못 재는 항목(정상 등록·위조·Injection·노하우 충돌·비인가 게시). `[{"key","label","target","passed","total","measured_by","measured_at"}]`, `pass` 생략 시 `passed === total`.
