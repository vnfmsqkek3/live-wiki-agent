// AWS_IAM 인증 AgentCore Gateway 에 MCP JSON-RPC 호출 (SigV4, service bedrock-agentcore). 점검용.
// 사용: node mcp-iam-call.mjs <gateway_url> <method> [params_json]
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const [url, method, params] = process.argv.slice(2);
const u = new URL(url);
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ? JSON.parse(params) : {} });
const signer = new SignatureV4({
  service: "bedrock-agentcore", region: process.env.AWS_REGION ?? "us-east-1",
  credentials: defaultProvider(), sha256: Hash.bind(null, "sha256"),
});
const req = await signer.sign({
  method: "POST", protocol: u.protocol, hostname: u.hostname, path: u.pathname,
  headers: { host: u.hostname, "content-type": "application/json", accept: "application/json, text/event-stream" }, body,
});
const r = await fetch(u, { method: "POST", headers: req.headers, body });
console.log(r.status, (await r.text()).slice(0, 2000));
