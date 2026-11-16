#!/usr/bin/env bash
# KB 색인 → HYBRID Retrieve + 메타데이터 ACL 필터 + Cohere Rerank smoke (docs/04 4.3 "M0에 1건 색인 → HYBRID 성공 확인").
# 합성 문서 2건: ALL 공개 1건, 제한 ACL 1건. 필터가 제한 문서를 걸러내는지 본다. 끝나면 문서를 지우고 재동기화한다.
# 사용: set -a; . ./.env.local; set +a; hanaeum-terraform/scripts/kb-smoke.sh [env=dev]
set -euo pipefail
ENV=${1:-dev}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
KB=$(p KB_ID); DS=$(p KB_DS_KNOWLEDGE_ID); BUCKET=$(p BUCKET_PUBLISHED); RERANK=$(p MODEL_RERANK)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL $1" >&2; exit 1; }

put_doc() { # id acl text
  printf '%s\n' "$3" > "$TMP/$1.md"
  printf '{"metadataAttributes":{"doc_id":"%s","document_type":"KNOWHOW","index_group":"wiki-knowledge","authority_status":"VERIFIED","freshness":"CURRENT","lifecycle":"PUBLISHED","effective_from":20261101,"effective_to":99991231,"acl_groups":["%s"],"dept":"여신","approval_id":"apr_SMOKE","content_hash":"sha256:smoke"}}' "$1" "$2" > "$TMP/$1.md.metadata.json"
  aws s3 cp "$TMP/$1.md" "s3://$BUCKET/knowledge/$1/$1.md" --sse aws:kms >/dev/null
  aws s3 cp "$TMP/$1.md.metadata.json" "s3://$BUCKET/knowledge/$1/$1.md.metadata.json" --sse aws:kms >/dev/null
}

ingest() {
  local job; job=$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --query ingestionJob.ingestionJobId --output text)
  for _ in $(seq 1 60); do
    read -r st failed < <(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --ingestion-job-id "$job" \
      --query '[ingestionJob.status, ingestionJob.statistics.numberOfDocumentsFailed]' --output text)
    [ "$st" = COMPLETE ] && { [ "$failed" = 0 ] || fail "ingestion failed docs=$failed"; return; }
    [ "$st" = FAILED ] && fail "ingestion job FAILED"
    sleep 5
  done
  fail "ingestion timeout"
}

retrieve() { # filter-json
  aws bedrock-agent-runtime retrieve --knowledge-base-id "$KB" --retrieval-query text="담보평가 시 확인 절차" \
    --retrieval-configuration "{\"vectorSearchConfiguration\":{\"numberOfResults\":10,\"overrideSearchType\":\"HYBRID\",\"filter\":$1,
      \"rerankingConfiguration\":{\"type\":\"BEDROCK_RERANKING_MODEL\",\"bedrockRerankingConfiguration\":{\"numberOfRerankedResults\":5,
      \"modelConfiguration\":{\"modelArn\":\"arn:aws:bedrock:${AWS_REGION}::foundation-model/${RERANK}\"}}}}}" \
    --query 'retrievalResults[].metadata.doc_id' --output text
}

put_doc doc_SMOKEALL ALL "SYNTHETIC 한빛은행 담보평가 노하우: 담보평가 시 감정평가서와 등기부등본을 확인한다."
put_doc doc_SMOKERESTRICT AUDIT_ONLY "SYNTHETIC 한빛은행 감사부 전용: 담보평가 시 확인 절차 내부 점검표."
ingest
sleep 30 # AOSS 반영 지연

F_ALL='{"andAll":[{"listContains":{"key":"acl_groups","value":"ALL"}},{"equals":{"key":"lifecycle","value":"PUBLISHED"}},{"lessThanOrEquals":{"key":"effective_from","value":20261116}},{"greaterThanOrEquals":{"key":"effective_to","value":20261116}}]}'
R=$(retrieve "$F_ALL"); echo "ACL=ALL -> $R"
[[ "$R" == *doc_SMOKEALL* && "$R" != *doc_SMOKERESTRICT* ]] || fail "ACL filter"
echo "PASS HYBRID + rerank + ACL filter (restricted doc hidden)"

F_NONE='{"andAll":[{"listContains":{"key":"acl_groups","value":"ALL"}},{"equals":{"key":"lifecycle","value":"BLOCKED"}}]}'
R=$(retrieve "$F_NONE"); echo "lifecycle=BLOCKED -> ${R:-<none>}"
[ -z "$R" ] || [ "$R" = None ] || fail "lifecycle filter"
echo "PASS lifecycle filter"

aws s3 rm "s3://$BUCKET/knowledge/doc_SMOKEALL/" --recursive >/dev/null
aws s3 rm "s3://$BUCKET/knowledge/doc_SMOKERESTRICT/" --recursive >/dev/null
ingest
# Ingestion COMPLETE 후에도 AOSS 반영까지 15~30초 지연 (트러블슈팅 11/16)
for i in $(seq 1 9); do R=$(retrieve "$F_ALL"); [[ "$R" != *doc_SMOKE* ]] && break; sleep 10; done
[[ "$R" != *doc_SMOKE* ]] || fail "deleted doc still indexed after 90s: $R"
echo "PASS delete -> reindex removes doc (${i}0s)"
echo "ALL PASS ($ENV)"
