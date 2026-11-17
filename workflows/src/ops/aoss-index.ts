// OpenSearch Serverless 벡터 인덱스 생성 Lambda (Terraform aws_lambda_invocation 이 apply 중 호출).
// 로컬 스크립트 대신 AWS 안에서 실행 (배포 원칙: terraform apply 만으로 AWS 리소스로 배포, 11/16).
// 이미 있으면 그대로 둔다. 매핑 변경은 인덱스 재생성이 필요하므로 자동으로 하지 않는다 (docs/04 6.4).
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

export type Input = { endpoint: string; index: string; mapping: string };
type Call = (method: string, body?: string) => Promise<{ status: number; text: string }>;

export async function ensureIndex(call: Call, mapping: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  // 데이터 접근 정책은 생성 후 반영까지 시간이 걸린다 → 403 이면 재시도 (Lambda 최대 15분 안에서 10분)
  for (let i = 1; i <= 40; i++) {
    const head = await call("HEAD");
    if (head.status === 200) return "exists";
    if (head.status === 404) {
      const put = await call("PUT", mapping);
      if (put.status === 200) return "created";
      if (put.status !== 403) throw new Error(`create failed ${put.status}: ${put.text.slice(0, 300)}`);
    }
    await sleep(15000);
  }
  throw new Error("index not reachable after 10 minutes (access policy?)");
}

export const handler = async (e: Input) => {
  const signer = new SignatureV4({
    service: "aoss", region: process.env.AWS_REGION ?? "us-east-1", credentials: defaultProvider(), sha256: Hash.bind(null, "sha256"),
  });
  const call: Call = async (method, body) => {
    const url = new URL(`${e.endpoint}/${e.index}`);
    const signed = await signer.sign({
      method, protocol: url.protocol, hostname: url.hostname, path: url.pathname,
      headers: { host: url.hostname, "content-type": "application/json", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }, body,
    });
    const res = await fetch(url, { method, headers: signed.headers, body });
    return { status: res.status, text: await res.text() };
  };
  return { index: e.index, result: await ensureIndex(call, e.mapping) };
};
