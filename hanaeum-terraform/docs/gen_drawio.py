"""prod AWS 아키텍처 draw.io 생성 (hanaeum-terraform envs/prod 기준). 출력 경로는 argv[1]."""
import sys
from xml.sax.saxutils import escape

cells = []
_id = [10]


def nid():
    _id[0] += 1
    return f"n{_id[0]}"


COL = {  # AWS 아키텍처 아이콘 카테고리 색
    "compute": "#ED7100", "network": "#8C4FFF", "storage": "#7AA116", "db": "#C925D1",
    "security": "#DD344C", "ai": "#01A88D", "integ": "#E7157B", "mgmt": "#E7157B", "dev": "#C925D1", "general": "#232F3E",
}


def icon(x, y, res, cat, label, w=48, lw=120):
    i = nid()
    style = (f"sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={COL[cat]};strokeColor=#ffffff;"
             f"dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;aspect=fixed;"
             f"pointerEvents=1;labelWidth={lw};shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{res};whiteSpace=wrap;")
    cells.append(f'<mxCell id="{i}" value="{escape(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{w}" as="geometry"/></mxCell>')
    return i


def group(x, y, w, h, label, kind, stroke, fill="none", dashed=0):
    i = nid()
    gr = {"cloud": "group_aws_cloud_alt", "region": "group_region", "vpc": "group_vpc2", "subnet_pub": "group_security_group",
          "subnet": "group_security_group", "generic": "group_generic"}[kind]
    style = (f"points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;container=0;"
             f"pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.{gr};"
             f"strokeColor={stroke};fillColor={fill};verticalAlign=top;align=left;spacingLeft=30;fontColor={stroke};dashed={dashed};")
    cells.append(f'<mxCell id="{i}" value="{escape(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i


def box(x, y, w, h, label, stroke="#879196", fill="#F7F7F7", fs=12, bold=1, dashed=0):
    i = nid()
    style = (f"rounded=1;arcSize=4;whiteSpace=wrap;html=1;strokeColor={stroke};fillColor={fill};fontColor=#232F3E;"
             f"verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;fontSize={fs};fontStyle={bold};dashed={dashed};")
    cells.append(f'<mxCell id="{i}" value="{escape(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i


def text(x, y, w, h, label, fs=11, color="#232F3E", bold=0, align="left"):
    i = nid()
    style = f"text;html=1;whiteSpace=wrap;fontSize={fs};fontColor={color};fontStyle={bold};align={align};verticalAlign=top;"
    cells.append(f'<mxCell id="{i}" value="{escape(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i


def edge(a, b, label="", color="#545B64", dashed=0, num=None, exit=None, entry=None):
    i = nid()
    lab = f"{num} {label}".strip() if num else label
    pts = ""
    if exit:
        pts += f"exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;"
    if entry:
        pts += f"entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;"
    style = (f"edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor={color};strokeWidth=1.5;endArrow=block;endFill=1;"
             f"fontSize=10;fontColor={color};labelBackgroundColor=#ffffff;dashed={dashed};{pts}")
    cells.append(f'<mxCell id="{i}" value="{escape(lab)}" style="{style}" edge="1" parent="1" source="{a}" target="{b}"><mxGeometry relative="1" as="geometry"/></mxCell>')
    return i


BLUE, GREEN, PURPLE, RED, GRAY = "#147EBA", "#2E7D32", "#7B1FA2", "#C62828", "#545B64"

# ---------- 제목 ----------
text(20, 10, 1500, 30, "Hanaeum Wiki — prod AWS 아키텍처 (Terraform hanaeum-terraform/envs/prod, us-east-1 · 11/18 13시 기준)", fs=18, bold=1)
text(20, 40, 1700, 22, "모든 리소스는 terraform apply 한 번으로 생성 · 빌드는 AWS CodeBuild 안에서만 · 데이터는 SYNTHETIC(하나은행 가상 데이터) · 리소스 이름 hanaeum-mvp-{약어}-{용도}", fs=11, color=GRAY)

# ---------- 사용자 ----------
u = icon(30, 150, "users", "mgmt", "직원\n(user · approver · admin)", 56)
ext = icon(2150, 930, "client", "general", "외부 챗봇·\n문서 생성 앱\n(MCP 클라이언트)", 56)

# ---------- AWS Cloud / Region ----------
group(110, 75, 1990, 1225, "AWS Cloud", "cloud", "#232F3E")
group(130, 105, 1950, 1180, "us-east-1", "region", "#00A4A6", dashed=1)

# 엣지(글로벌)
waf = icon(170, 150, "waf", "security", "WAF\nCommon·KnownBadInputs·rate")
cf = icon(300, 150, "cloudfront", "network", "CloudFront\n/v1/* 캐시 없음·SSE")
cog = icon(170, 290, "cognito", "security", "Cognito User Pool\nuser·approver·admin\n외부 MCP client_credentials\n(hanaeum-mcp/read)")

# ---------- VPC ----------
group(420, 120, 640, 640, "VPC (public · app · data 서브넷)", "vpc", "#8C4FFF")
box(440, 155, 600, 100, "public subnet", stroke="#7AA116", fill="#F2F8EC", fs=11)
alb = icon(470, 180, "application_load_balancer", "network", "ALB\nCloudFront 프리픽스만 허용")
nat = icon(640, 180, "nat_gateway", "network", "NAT Gateway")
box(440, 270, 600, 300, "app subnet (private)", stroke="#147EBA", fill="#EEF5FB", fs=11)
web = icon(470, 305, "fargate", "compute", "ECS Fargate web\nNext.js (ARM64)")
api = icon(610, 305, "fargate", "compute", "ECS Fargate API\nHono · /v1/*")
vl1 = icon(780, 305, "lambda", "compute", "graph-upsert\n(동시성 1)")
vl2 = icon(910, 305, "lambda", "compute", "mcp-graph\n(trace_impact)")
text(455, 450, 570, 60, "API: 업로드 URL·진행바·결재·보관함(정리본/원문)·검색(질의 재구성 Haiku)·가이드(SSE)·실패 사유·원본 다운로드·문서 삭제·운영 도구(Agent 실행 기록·규정 변경 영향)  |  VPC Lambda: Neptune 그래프", fs=10, color=GRAY)
box(440, 585, 600, 160, "data subnet (private)", stroke="#C925D1", fill="#FBF0FB", fs=11)
aur = icon(470, 620, "aurora", "db", "Aurora PostgreSQL 17\nServerless v2 (min 0.5 ACU)\nRDS Data API")
nep = icon(640, 620, "neptune", "db", "Neptune Serverless\nIAM 인증 · Change Impact")
text(830, 605, 205, 135, "거버넌스 저장소: 문서 메타·검수 결과·승인(자기 승인 금지 CHECK)·피드백·초안·감사(추가만, 트리거)\nLambda·ECS 는 Data API(HTTPS+IAM)로 접근 → VPC 연결 불필요\npgvector: 업무 분류 칸 임베딩 · 주장(claims)·지식 부채 뷰\n스키마 db/migrations 001~008 (apply 시 자동)", fs=9, color=GRAY)

# ---------- 데이터 저장 ----------
box(1080, 120, 480, 285, "데이터 저장 (KMS CMK 암호화)", stroke=GREEN, fill="#F4FAF4")
s3q = icon(1100, 160, "s3", "storage", "S3 quarantine\n원본·work·masked\n(쪽 이미지·그림·정리본)")
s3p = icon(1220, 160, "s3", "storage", "S3 published\nlegal·knowledge")
s3a = icon(1340, 160, "s3", "storage", "S3 artifact\nLambda zip·Tool 스키마")
gd = icon(1460, 160, "guardduty", "security", "GuardDuty\nMalware Protection(S3)")
ddb = icon(1100, 280, "dynamodb", "db", "DynamoDB\nworkflows·regulations")
sec = icon(1280, 280, "secrets_manager", "security", "Secrets Manager\n데모 계정·DB app 사용자")
ssm = icon(1420, 280, "systems_manager", "mgmt", "SSM Parameter\n/hanaeum-mvp/prod/*")

# ---------- 업로드 트리거 ----------
box(1580, 120, 480, 285, "업로드 트리거", stroke="#E7157B", fill="#FDF2F8")
eb = icon(1600, 165, "eventbridge", "integ", "EventBridge\nObjectCreated")
sqs = icon(1730, 165, "sqs", "integ", "SQS ingest\n+ DLQ")
td = icon(1860, 165, "lambda", "compute", "type-detection\n→ InvokeAgentRuntime")
sch = icon(1600, 290, "eventbridge", "integ", "Scheduler\n00:00 최신성 · 03:00 분류")
fs = icon(1730, 290, "lambda", "compute", "freshness-sweep ·\ncategory-sweep")

# ---------- AgentCore 파이프라인 ----------
box(150, 790, 1100, 480, "문서 처리 — Amazon Bedrock AgentCore (시스템 전용, AWS_IAM)", stroke=BLUE, fill="#EEF5FB")
rtp = icon(180, 830, "bedrock", "ai", "AgentCore Runtime\n오케스트레이터\n(Strands Graph)")
gwp = icon(360, 830, "bedrock", "ai", "AgentCore Gateway\npipeline (MCP)\nPolicy ENFORCE")
text(170, 1000, 360, 110, "Cedar: 오케스트레이터 Role 만 단계 Tool 허용, 그 외 기본 거부\nObservability: 로그 → CloudWatch, Trace → X-Ray(Transaction Search)", fs=10, color=GRAY)
steps = [
    ("MalwareCheck", "lambda"), ("FileStructureCheck", "lambda"), ("ConvertToPdf\nLibreOffice", "lambda"), ("TextLayerExtract", "lambda"), ("PageRender\n모든 쪽", "lambda"),
    ("OcrIfNeeded\nPP-StructureV3", "lambda"), ("SegmentBuild\n그림 글자 분리", "lambda"), ("PiiScan\n+ Guardrail", "lambda"), ("ImageDescribe\n그림 쪽 정리본", "lambda"),
    ("InjectionScan", "lambda"), ("PageSummarize\n쪽 요약", "lambda"), ("Classify\n분류·정리본", "lambda"), ("ReferenceCheck\n확인 필요", "lambda"), ("TrustGate\n검증·주장", "lambda"), ("await_review\n사람 승인", "lambda"),
    ("Promote", "lambda"), ("KbIngest", "lambda"), ("GraphUpsert", "lambda"), ("ExplainFindings\n실패 사유 설명", "lambda"), ("Finalize", "lambda"), ("PurgeDocument\n삭제 흐름", "lambda"),
]
sx, sy = 560, 820
step_ids = {}
for k, (name, res) in enumerate(steps):
    r, c = divmod(k, 7)
    step_ids[name.split("\n")[0]] = icon(sx + c * 96, sy + r * 118, res, "compute", f"{k + 1}. {name}", 38, lw=92)
text(560, 1060 + 0, 680, 10, "", fs=1)
text(560, 1180, 680, 80, "단계 Lambda = Gateway Tool (target___단계). 모델 호출 단계는 model-caller Role → 원본·work/ 거부, 마스킹본만. 단계 기록 WF#/STEP# → 진행바·운영 도구 실행 기록.\n승인 = 사람만(버전·해시 1회, MVP: 관리자 본인 문서 자기 승인 허용·표시). ReferenceCheck 는 비차단(240초 예산). 삭제 = PurgeDocument(게시본·격리 전 버전) → KbIngest 재색인 → GraphUpsert 삭제 → Finalize.", fs=10, color=GRAY)

text(170, 1110, 380, 150, "단계가 쓰는 리소스\n· 문서 메타·검수 결과 → Aurora (Data API)\n· OcrIfNeeded → SageMaker Async(PaddleOCR)\n· PiiScan·ImageDescribe → Guardrail·Claude 비전\n· PageSummarize·Classify 정리본 → Claude Haiku\n· Promote → S3 published / KbIngest → KB\n· GraphUpsert → Neptune (VPC Lambda)", fs=10, color="#232F3E")
text(1100, 365, 450, 40, "S3 업로드 → GuardDuty 검사 결과 태그 → MalwareCheck 단계가 확인", fs=10, color=GRAY)
text(455, 395, 570, 50, "API → Aurora(문서·결재·감사, Data API) · DynamoDB(실행 기록) · KB(/v1/search) · Cognito JWT 검증 · 오케스트레이터 resume·delete", fs=10, color=GRAY)

# ---------- AI / 검색 ----------
box(1270, 430, 810, 430, "AI · 검색", stroke=RED, fill="#FDF3F3")
sm = icon(1300, 470, "sagemaker", "ai", "SageMaker Async\nPaddleOCR PP-StructureV3\n(GPU g4dn · 10쪽 청크·3병렬)\nprod 최소 0대 · dev 1대")
br = icon(1470, 470, "bedrock", "ai", "Bedrock 모델\nClaude Sonnet·Haiku\nTitan Embed·Cohere Rerank\n(질의 재구성: Haiku)")
grd = icon(1640, 470, "bedrock", "ai", "Bedrock Guardrail\nPII ANONYMIZE\n(카드·비밀번호·키 등)")
kb = icon(1300, 640, "bedrock", "ai", "Bedrock Knowledge Base\nHYBRID + Rerank 0.30\n쪽·장 단위 · 쪽 맥락 머리")
aoss = icon(1470, 640, "elasticsearch_service", "ai", "OpenSearch Serverless\n벡터 인덱스")
chk = icon(1640, 640, "lambda", "compute", "kb-chunker\n조문·쪽·장 단위\n표 유지·마스킹 흔적 제외")
brw = icon(1810, 640, "bedrock", "ai", "AgentCore Browser\n법령 원문 ·\n참조 확인 웹 검색")

# ---------- 사용자 가이드 ----------
box(1270, 880, 810, 390, "사용자 가이드 — AgentCore (Cognito JWT)", stroke=PURPLE, fill="#F7F0FB")
rtg = icon(1300, 920, "bedrock", "ai", "AgentCore Runtime\n가이드 Agent\nSSE 진행 문구")
gwu = icon(1480, 920, "bedrock", "ai", "AgentCore Gateway\nuser (MCP, JWT)\n직원 + 외부 클라이언트")
icp = icon(1660, 920, "lambda", "compute", "interceptor\n__actor 주입 ·\n외부는 읽기 도구만")
tools = [("mcp-search", "search\nget_wiki_document"), ("mcp-regulation", "regulation"), ("mcp-graph", "graph"), ("mcp-privacy", "privacy"), ("mcp-approval", "approval\n검토 요청만")]
tool_ids = []
for k, (n, t) in enumerate(tools):
    tool_ids.append(icon(1300 + k * 150, 1080, "lambda", "compute", f"{n}\nTarget {t}", 40))
text(1290, 1185, 780, 75, "search→질의 재구성(규칙+Haiku, PII 마스킹 후)→KB 여러 질의·문서 단위 병합→Aurora 상태 재검증, regulation→Registry·AgentCore Browser, graph→Neptune trace_impact(운영 도구 규정 변경 영향도 이 Tool). 승인·게시 Tool 은 사용자 Gateway 에 없음 + Cedar 로 Target 만 허용. 사용자 토큰으로 부서 ACL 재검증.", fs=10, color=GRAY)

# ---------- 빌드·운영 ----------
box(150, 1300 - 15, 1930, 0, "", stroke="none", fill="none")
box(150, 1310, 1930, 150, "빌드 · 보안 · 관측 (terraform apply 가 CodeBuild 를 실행 — 로컬 빌드 산출물 업로드 없음)", stroke=GRAY, fill="#FAFAFA")
cb1 = icon(180, 1350, "codebuild", "dev", "CodeBuild lambda\nNode 24 · 커밋별 zip")
cb2 = icon(340, 1350, "codebuild", "dev", "CodeBuild webapp\nweb·api·agents·convert-pdf")
cb3 = icon(500, 1350, "codebuild", "dev", "CodeBuild ocr\nDLC cu118 이미지")
ecr = icon(660, 1350, "ecr", "compute", "ECR (태그 불변)\nweb·api·pipeline·guide\nocr·convert-pdf")
kms = icon(840, 1350, "key_management_service", "security", "KMS CMK\n팀 공용 키")
cw = icon(1000, 1350, "cloudwatch_2", "mgmt", "CloudWatch\nGenAI Observability\nAgentCore 로그")
xr = icon(1160, 1350, "xray", "mgmt", "X-Ray\nTransaction Search")
iam = icon(1320, 1350, "identity_and_access_management", "security", "IAM\n단계별 최소 권한\nmodel-caller 태그")
tfs = icon(1500, 1350, "s3", "storage", "S3 tfstate\n(bootstrap, use_lockfile)\n+ DB 마이그레이션 local-exec")
text(1650, 1350, 420, 100, "GitHub(public) 커밋 ref → CodeBuild clone → 빌드\nlambda_refs·webapp_source_ref·agents_source_ref·ocr_source_ref 로 버전 고정", fs=10, color=GRAY)

# ---------- 흐름 ----------
edge(u, waf, "HTTPS", BLUE, num="①")
edge(waf, cf, "", BLUE)
edge(cf, alb, "", BLUE)
edge(alb, web, "/", BLUE)
edge(alb, api, "/v1/*", BLUE)
edge(u, cog, "로그인", PURPLE, num="②")
edge(u, s3q, "presigned PUT (원본 1개)", GREEN, num="③", exit=(0.5, 0), entry=(0.5, 0))
edge(s3q, eb, "ObjectCreated", "#E7157B", num="④", exit=(1, 0.3), entry=(0, 0.3))
edge(eb, sqs, "", "#E7157B")
edge(sqs, td, "", "#E7157B")
edge(td, rtp, "InvokeAgentRuntime", BLUE, num="⑤", exit=(0.5, 1), entry=(0.5, 0))
edge(rtp, gwp, "Tool 호출", BLUE)
edge(gwp, step_ids["MalwareCheck"], "단계 Tool", BLUE)
edge(kb, aoss, "", RED)
edge(vl1, nep, "openCypher", PURPLE, exit=(0.5, 1), entry=(1, 0.5))
edge(api, aur, "Data API", GREEN, dashed=1, exit=(0.5, 1), entry=(0.5, 0))
edge(api, rtg, "가이드 질의 (SSE)", PURPLE, num="⑥", exit=(0.5, 1), entry=(0, 0.5))
edge(rtg, gwu, "사용자 토큰", PURPLE)
edge(gwu, icp, "REQUEST", PURPLE, dashed=1)
for t in tool_ids:
    edge(gwu, t, "", PURPLE)
edge(sch, fs, "", "#E7157B")
edge(ext, icp, "⑧ MCP (Bearer, 읽기만)", PURPLE, exit=(0, 0.5), entry=(1, 0.5))
edge(cb2, ecr, "", GRAY)
edge(cb3, ecr, "", GRAY)

# 범례
box(150, 1475, 1930, 60, "", stroke="#D5DBDB", fill="#FFFFFF", bold=0)
text(165, 1485, 1900, 50, "흐름: ① 접속(WAF→CloudFront→ALB→ECS) ② 로그인(Cognito) ③ 원본 업로드(S3 quarantine) ④ 이벤트(EventBridge→SQS→type-detection) ⑤ AgentCore 오케스트레이터가 단계 Tool 호출 → 사람 승인 → 게시·색인·그래프 ⑥ 가이드 질의(Runtime→사용자 Gateway Tool, SSE) ⑦ 문서 삭제(DELETE → 같은 오케스트레이터 deleteGraph) ⑧ 외부 MCP(client_credentials 토큰 → 사용자 Gateway, 공개 문서 읽기만).  "
     "선: 파랑=요청/오케스트레이션, 초록=데이터 저장, 빨강=AI·검색, 보라=사용자 경로·그래프, 점선=부수 호출.", fs=11)

xml = ('<mxfile host="app.diagrams.net"><diagram id="prod" name="prod AWS"><mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" '
       'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="2260" pageHeight="1560" math="0" shadow="0">'
       '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' + "".join(cells) + "</root></mxGraphModel></diagram></mxfile>")
open(sys.argv[1], "w").write(xml)
print("cells", len(cells))
