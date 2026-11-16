#!/usr/bin/env bash
# OCR 경로 smoke: 합성 한국어 조문 PNG → MalwareCheck → PageRender → OcrIfNeeded(SageMaker Async) → result.json 확인.
# 엔드포인트가 0대면 깨어나는 데 10분 이상 걸릴 수 있다. 끝나면 승인 단계에서 REJECT 로 종료하고 테스트 데이터를 지운다.
# 사용: set -a; . ./.env.local; set +a; workflows/scripts/smoke-ocr.sh [env=dev]
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV=${1:-dev}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
SFN=$(p SFN_INGEST_ARN); TABLE=$(p TABLE_WORKFLOWS); DOCS=$(p TABLE_DOCUMENTS); BUCKET=$(p BUCKET_QUARANTINE)
ulid() { node -e 'const B="0123456789ABCDEFGHJKMNPQRSTVWXYZ";let t="",n=Date.now();for(let i=0;i<10;i++,n=Math.floor(n/32))t=B[n%32]+t;let r="";for(let i=0;i<16;i++)r+=B[Math.floor(Math.random()*32)];console.log(t+r)'; }
DOC="doc_$(ulid)"; WF="wf_$(ulid)"; TMP=$(mktemp -d); NOW=$(date -u +%FT%TZ)
fail() { echo "FAIL $1" >&2; exit 1; }
cleanup() {
  aws s3 rm "s3://$BUCKET/$DOC/" --recursive >/dev/null 2>&1 || true
  aws s3 rm "s3://$BUCKET/_ocr-async/in/$DOC/" --recursive >/dev/null 2>&1 || true
  aws dynamodb delete-item --table-name "$DOCS" --key "{\"pk\":{\"S\":\"DOC#$DOC\"},\"sk\":{\"S\":\"META\"}}" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

node -e '
const { createCanvas } = require("@napi-rs/canvas");
const c = createCanvas(1600, 400), g = c.getContext("2d");
g.fillStyle = "#fff"; g.fillRect(0, 0, 1600, 400); g.fillStyle = "#000"; g.font = "44px sans-serif";
["SYNTHETIC 한빛은행 여신규정", "제12조(승인 기준) ① 여신 승인 한도는 3억원으로 한다.", "② 담보평가는 감정평가서를 확인한다."]
  .forEach((t, i) => g.fillText(t, 40, 100 + i * 100));
require("fs").writeFileSync(process.argv[1], c.toBuffer("image/png"));
' "$TMP/page.png"

# API(upload-url·analyze)가 만드는 형식의 Documents 레코드. 업로드하면 type-detection 이 워크플로를 시작한다
aws dynamodb put-item --table-name "$DOCS" --item "$(cat <<JSON
{"pk":{"S":"DOC#$DOC"},"sk":{"S":"META"},"doc_id":{"S":"$DOC"},"version":{"N":"1"},"owner":{"S":"smoke-author"},
 "title":{"S":"SYNTHETIC smoke OCR"},"dept":{"S":"여신"},"acl_groups":{"L":[{"S":"ALL"}]},"ext":{"S":"png"},"workflow_id":{"S":"$WF"},
 "lifecycle":{"S":"QUARANTINED"},"authority_status":{"S":"UNVERIFIED"},"freshness":{"S":"CURRENT"},"findings":{"L":[]},
 "created_at":{"S":"$NOW"},"updated_at":{"S":"$NOW"}}
JSON
)"
aws s3 cp "$TMP/page.png" "s3://$BUCKET/$DOC/original.png" --sse aws:kms >/dev/null
# 오케스트레이션은 AgentCore(SSM PIPELINE_RUNTIME_ARN 설정 시) 또는 SFN. 둘 다 단계 기록 WF#/STEP# 을 남기므로 그것으로 판단
echo "uploaded $DOC ($WF). OCR 엔드포인트가 0대면 최대 30분"
ST=None
for i in $(seq 1 120); do
  ST=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF\"},\"sk\":{\"S\":\"STEP#OcrIfNeeded\"}}" --query Item.status.S --output text)
  case "$ST" in OK|REVIEW_REQUIRED|FAILED) break ;; esac
  EX=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF\"},\"sk\":{\"S\":\"EXECUTION\"}}" --query Item.status.S --output text)
  [[ "$EX" == FAILED || "$EX" == SUCCEEDED ]] && fail "execution ended ($EX) before OCR"
  (( i % 4 == 0 )) && echo "  waiting OCR ($((i * 15))s, step=$ST)"
  sleep 15
done
[[ "$ST" == OK || "$ST" == REVIEW_REQUIRED ]] || fail "OcrIfNeeded=$ST"

aws s3 cp "s3://$BUCKET/$DOC/work/ocr/result.json" "$TMP/result.json" >/dev/null
python3 - "$TMP/result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
blocks = [b for p in r["pages"] for b in p["blocks"]]
text = " ".join(b["text"] for b in blocks)
assert r["pages"][0]["source"] == "ocr", "source"
assert all("confidence" in b and "bbox" in b for b in blocks), "confidence/bbox"
for w in ["한빛은행", "제12조", "감정평가서"]:
    assert w in text.replace(" ", "") or w in text, f"missing {w}"
print(f"blocks={len(blocks)} avg_conf={sum(b['confidence'] for b in blocks)/len(blocks):.3f}")
PY
echo "PASS OCR result.json (Korean text, confidence, bbox) step=$ST"

# OCR 이후 단계(IN_REVIEW 까지)는 오케스트레이터가 계속 진행한다. 이 smoke 는 OCR 결과만 본다
echo "ALL PASS ($ENV)"
