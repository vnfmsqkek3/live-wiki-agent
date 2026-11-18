#!/usr/bin/env bash
# prod 시험 체크리스트 '인프라(yoyo0704)' I1~I7 (members/dhxorb96/qa/20261118_prod시험_체크리스트.md). 사용: prod-infra-check.sh [prefix=/hanaeum-mvp/prod/] [suffix=""]
set -uo pipefail
P=${1:-/hanaeum-mvp/prod/} S=${2:-}
ssm() { aws ssm get-parameter --name "$P$1" --query Parameter.Value --output text 2>/dev/null; }
ok() { echo "$1 $2 | $3"; }
# I1 OCR 엔드포인트 1/1
EP=hanaeum-mvp-sm-ocr$S
st=$(aws sagemaker describe-endpoint --endpoint-name $EP --query '[EndpointStatus,ProductionVariants[0].CurrentInstanceCount]' --output text)
sc=$(aws application-autoscaling describe-scalable-targets --service-namespace sagemaker --resource-ids endpoint/$EP/variant/AllTraffic --query 'ScalableTargets[0].[MinCapacity,MaxCapacity]' --output text)
[[ "$st" == "InService"*1 && "$sc" == $'1\t1' ]] && ok I1 통과 "$st min/max $sc" || ok I1 실패 "$st min/max $sc"
# I2·I3 외부 MCP 토큰·도구
SEC=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/mcp-external-client$S --query SecretString --output text)
read -r CID CSEC TEP SCOPE < <(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["client_id"],d["client_secret"],d["token_endpoint"],d["scope"])' "$SEC")
TOK=$(curl -s -u "$CID:$CSEC" -d "grant_type=client_credentials&scope=$SCOPE" "$TEP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
GW=$(ssm USER_GATEWAY_URL)
mcp() { curl -s -X POST "$GW" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1"; }
TL=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import json,sys; t=sys.stdin.read(); t=t[t.find("{"):]; print(" ".join(sorted(x["name"] for x in json.loads(t)["result"]["tools"])))' 2>/dev/null)
AP=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"approval___create_review_request","arguments":{}}}' | grep -o 'forbidden[^"]*' | head -1)
SR=$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search___search_wiki","arguments":{"query":"담보"}}}' | grep -c '"result"')
[[ -n "$TOK" && "$SR" -ge 1 && -n "$AP" ]] && ok I2 통과 "토큰 $SCOPE, 검색 응답, 결재 도구 차단($AP)" || ok I2 실패 "tok=${#TOK} search=$SR approval=$AP"
for t in search___search_wiki search___get_wiki_document; do [[ " $TL " == *" $t "* ]] || miss="$miss $t"; done
[[ -z "${miss:-}" ]] && ok I3 통과 "도구 $(wc -w <<<"$TL")개 (search_wiki·get_wiki_document 포함)" || ok I3 실패 "없음:$miss"
# I4 마이그레이션
CL=$(aws rds describe-db-clusters --query "DBClusters[?DBClusterIdentifier=='hanaeum-mvp-aurora$S'].DBClusterArn" --output text)
MS=$(aws rds describe-db-clusters --db-cluster-identifier hanaeum-mvp-aurora$S --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text 2>/dev/null)
DB=$(aws rds describe-db-clusters --db-cluster-identifier hanaeum-mvp-aurora$S --query 'DBClusters[0].DatabaseName' --output text 2>/dev/null)
MG=$(aws rds-data execute-statement --resource-arn "$CL" --secret-arn "$MS" --database "$DB" --sql "select string_agg(left(name,3), ',' order by name) from schema_migrations" --query 'records[0][0].stringValue' --output text 2>&1)
[[ "$MG" == *008* ]] && ok I4 통과 "$MG" || ok I4 실패 "$MG"
# I5 WAF 없음
W=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment!=null && contains(Comment,'hanaeum')].[DomainName,WebACLId]" --output text)
[[ -z "$(awk '$2!=""' <<<"$W")" ]] && ok I5 통과 "WebACL 없음" || ok I5 확인 "$W"
# I6 Finalize
F=$(aws lambda get-function-configuration --function-name hanaeum-mvp-lambda-finalize$S --query '[Timeout,Environment.Variables.TABLE_REGULATIONS!=`null`,Environment.Variables.KB_ID!=`null`,Environment.Variables.MODEL_SONNET!=`null`]' --output text)
[[ "$F" == $'300\tTrue\tTrue\tTrue' ]] && ok I6 통과 "timeout 300, env 있음" || ok I6 실패 "$F"
# I7 API Role S3
R=$(aws iam list-roles --query "Roles[?RoleName=='hanaeum-mvp-role-ecs-api$S'].RoleName" --output text)
PD=$(for n in $(aws iam list-role-policies --role-name "$R" --query PolicyNames --output text); do aws iam get-role-policy --role-name "$R" --policy-name $n --query PolicyDocument --output json; done)
[[ "$PD" == *'/doc_*'* && "$PD" == *GetObjectVersion* ]] && ok I7 통과 "doc_* 삭제·목록, original.* 버전 읽기" || ok I7 실패 "role=$R"
