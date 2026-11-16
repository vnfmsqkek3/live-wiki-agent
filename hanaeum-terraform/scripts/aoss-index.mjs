// OpenSearch Serverless 벡터 인덱스를 만든다 (이미 있으면 그대로 둔다).
// Terraform aws provider 에 인덱스 리소스가 없어 terraform_data local-exec 로 호출한다.
// 메타데이터는 dynamic mapping (Bedrock 문자열 필터가 {field}.keyword 를 조회). 매핑 파일: modules/kb/index-mapping.json
// ponytail: 매핑 변경은 인덱스 재생성이 필요하므로 자동으로 하지 않는다 (docs/04 6.4 "인덱스 삭제 후 재생성 금지").
// 사용: node aoss-index.mjs <collection_endpoint> <index_name> <mapping.json>
import { readFileSync } from "node:fs";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const [endpoint, index, mappingPath] = process.argv.slice(2);
if (!endpoint || !index || !mappingPath) throw new Error("usage: aoss-index.mjs <endpoint> <index> <mapping.json>");
const region = process.env.AWS_REGION ?? "us-east-1";
const signer = new SignatureV4({
  service: "aoss", region, credentials: defaultProvider(),
  sha256: Hash.bind(null, "sha256"),
});

async function call(method, body) {
  const url = new URL(`${endpoint}/${index}`);
  const req = {
    method, protocol: url.protocol, hostname: url.hostname, path: url.pathname,
    headers: { host: url.hostname, "content-type": "application/json", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
    body,
  };
  const signed = await signer.sign(req);
  const res = await fetch(url, { method, headers: signed.headers, body });
  return { status: res.status, text: await res.text() };
}

// 데이터 접근 정책은 생성 후 반영까지 시간이 걸린다 → 403 이면 재시도
for (let i = 1; i <= 20; i++) {
  const head = await call("HEAD");
  if (head.status === 200) { console.log(`index ${index} exists`); process.exit(0); }
  if (head.status === 404) {
    const put = await call("PUT", readFileSync(mappingPath, "utf8"));
    if (put.status === 200) { console.log(`index ${index} created`); process.exit(0); }
    if (put.status !== 403) throw new Error(`create failed ${put.status}: ${put.text}`);
  }
  console.log(`waiting for access policy (${head.status}) ${i}/20`);
  await new Promise((r) => setTimeout(r, 15000));
}
throw new Error("index not reachable after 5 minutes");
