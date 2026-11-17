# @hanaeum/db

거버넌스 저장소(Aurora PostgreSQL)를 RDS Data API 로 부르는 얇은 클라이언트. 연결 풀·VPC 불필요.
설정: 환경변수 `DB_CLUSTER_ARN`, `DB_SECRET_ARN`, `DB_NAME` (SSM `/hanaeum-mvp/{env}/DB_*`). 권한은 Terraform `module.aurora.app_statements`.

```js
import { db } from "@hanaeum/db";
const d = db(); // 환경변수 사용
const rows = await d.query("SELECT * FROM documents WHERE doc_id = :id", { id });
await d.tx(async (q) => { await q("SELECT 1 FROM documents WHERE doc_id = :id FOR UPDATE", { id }); /* ... */ });
```

| JS 값 | 파라미터 | SQL 쪽 |
|---|---|---|
| string / number / boolean / null | stringValue / longValue·doubleValue / booleanValue / isNull | 그대로. 시각은 `:at::timestamptz` |
| 배열·객체 | JSON 문자열 (typeHint JSON) | `:attrs` (jsonb), text[] 는 `ARRAY(SELECT jsonb_array_elements_text(:acl::jsonb))` |

결과: 행 객체 배열. `timestamptz` → ISO 문자열(`Z`), `jsonb`/`json` → 파싱된 값, 배열 → JS 배열.
일시정지(dev 0 ACU)에서 깨어나는 동안의 `DatabaseResumingException` 은 최대 60초 재시도한다.
