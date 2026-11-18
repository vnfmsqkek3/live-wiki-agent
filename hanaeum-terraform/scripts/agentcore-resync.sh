#!/usr/bin/env bash
# AgentCore Gateway 는 Lambda 대상의 도구 스키마와 Cedar 정책의 행동 목록을 만들 때만 읽는다(11/18 get_wiki_document 실측).
# 스키마(tools.json)가 바뀌면 같은 설정으로 update-gateway-target → update-policy 를 다시 불러 새 도구를 반영한다.
# 사용: agentcore-resync.sh <gateway_id> <policy_engine_id> <policy_id>
set -euo pipefail
GW=$1 PE=$2 PID=$3
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for TID in $(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$GW" --query 'items[].targetId' --output text); do
  aws bedrock-agentcore-control get-gateway-target --gateway-identifier "$GW" --target-id "$TID" --output json > "$TMP/t.json"
  python3 - "$TMP/t.json" "$GW" "$TID" > "$TMP/u.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
out = {"gatewayIdentifier": sys.argv[2], "targetId": sys.argv[3], "name": d["name"], "targetConfiguration": d["targetConfiguration"],
       "credentialProviderConfigurations": d["credentialProviderConfigurations"]}
if d.get("description"): out["description"] = d["description"]
print(json.dumps(out))
PY
  aws bedrock-agentcore-control update-gateway-target --cli-input-json "file://$TMP/u.json" >/dev/null
  for _ in $(seq 1 30); do [ "$(aws bedrock-agentcore-control get-gateway-target --gateway-identifier "$GW" --target-id "$TID" --query status --output text)" = READY ] && break; sleep 5; done
done
aws bedrock-agentcore-control get-policy --policy-engine-id "$PE" --policy-id "$PID" --output json > "$TMP/p.json"
python3 -c "import json,sys; d=json.load(open('$TMP/p.json')); print(json.dumps({'policyEngineId':'$PE','policyId':'$PID','definition':d['definition'],'validationMode':'FAIL_ON_ANY_FINDINGS'}))" > "$TMP/pu.json"
aws bedrock-agentcore-control update-policy --cli-input-json "file://$TMP/pu.json" >/dev/null
for _ in $(seq 1 30); do [ "$(aws bedrock-agentcore-control get-policy --policy-engine-id "$PE" --policy-id "$PID" --query status --output text)" = ACTIVE ] && break; sleep 5; done
echo "resynced gateway targets + policy"
