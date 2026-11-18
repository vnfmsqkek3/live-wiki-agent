// 최소 Lambda Runtime API 루프 (aws-lambda-ric 빌드 의존성 없이). handler.ts 는 Node 24 타입 제거로 그대로 실행
import { handler } from "./index.ts";

const api = `http://${process.env.AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime`;
for (;;) {
  const next = await fetch(`${api}/invocation/next`);
  const id = next.headers.get("lambda-runtime-aws-request-id");
  const event = await next.json();
  try {
    const out = await handler(event);
    await fetch(`${api}/invocation/${id}/response`, { method: "POST", body: JSON.stringify(out) });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(JSON.stringify({ step: "ConvertToPdf", error: err.name, message: err.message.slice(0, 300) }));
    await fetch(`${api}/invocation/${id}/error`, {
      method: "POST", headers: { "Lambda-Runtime-Function-Error-Type": "Unhandled" },
      body: JSON.stringify({ errorType: err.name, errorMessage: err.message.slice(0, 500) }),
    });
  }
}
