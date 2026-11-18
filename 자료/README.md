# 자료

외부에서 내려받은 참고 자료. 구조: `자료/{용도}/{카테고리}/`. 파일명: `YYYYMMDD_{출처}_{제목}.{확장자}`

| 용도 | 카테고리 | 넣는 것 | 주 사용자 |
|---|---|---|---|
| 데이터원천 | 법령 | 파이프라인 입력용 공개 법령 원문 (XML/HWPX/PDF) | let522mj |
| 데이터원천 | 업로드시험 | 업로드 파이프라인(전부 OCR·표·레이아웃·그림) 시험용 문서. 가상 데이터판만 둠(11/18 사용자 결정) | yoyo0704 |
| 데이터원천 | 규정서식 | 합성 규정·노하우 작성 시 참고할 공개 서식·구조 예시 | let522mj |
| 규제참고 | 금융규제 | 전자금융감독규정, 신용정보법, 망분리 로드맵 등 | 전원 |
| 규제참고 | AI가이드라인 | 금융분야 AI 가이드라인, 개인정보 가명처리 가이드 등 | 전원 |
| 기술참고 | aws | AWS 서비스 문서·제약 (AgentCore, Bedrock KB, Neptune 등) | yoyo0704 |
| 기술참고 | sdk | Strands Agents, MCP, 프레임워크 문서 | dhxorb96 |
| 기술참고 | ocr | PaddleOCR 모델·컨테이너 자료 | yoyo0704 |
| 디자인참고 | ui | 화면 레퍼런스, 디자인 skill 자료 | dhxorb96 |

- 맞는 카테고리가 없을 때만 새 폴더를 만들고 이 표에 행을 추가한다.
- 실제 은행 내부 자료는 넣지 않는다. 저장소가 public이므로 원본 파일(PDF·HWPX·이미지 등)은 Git에 올리지 않고 이 색인만 올린다. 다른 팀원은 출처 URL로 다시 받는다.
- 예외: `데이터원천/법령/*.md` 공개 법령 원문은 Git에 올린다 (공개 자료, 저작권 보호 대상 아님. 파서 회귀 테스트 입력).

## 색인

| 파일 | 출처 URL | 받은 날 | 용도 | 라이선스/공개 여부 | 받은 사람 |
|---|---|---|---|---|---|
| `데이터원천/법령/20261116_legalize-kr_은행법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/은행법/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_금융소비자보호법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/금융소비자보호에관한법률/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_전자금융거래법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/전자금융거래법/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_자본시장법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/자본시장과금융투자업에관한법률/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_신용정보법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/신용정보의이용및보호에관한법률/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_개인정보보호법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/개인정보보호법/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_특정금융정보법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/특정금융거래정보의보고및이용등에관한법률/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_예금자보호법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/예금자보호법/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_금융회사지배구조법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/금융회사의지배구조에관한법률/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/법령/20261116_legalize-kr_민법.md` | https://github.com/legalize-kr/legalize-kr/blob/main/kr/민법/법률.md (원 출처 law.go.kr) | 2026-11-16 | 파서 일반화 검증 (`tests/evaluations/cases/src/public-laws.ts`) | 법령은 저작권 보호 대상 아님(저작권법 제7조). 변환 저장소는 라이선스 미표기 | let522mj |
| `데이터원천/업로드시험/20261118_하나은행가상_과천사옥-복합기-스캐너-설치-매뉴얼_SYNTHETIC.pdf` | 과천 매뉴얼 가상 데이터판 (직원 이름·이메일 → 가상직원·staff@hanabank.example, 로고 → 하나은행(가상), MZ_OFFICE → HANA_OFFICE, 쪽마다 SYNTHETIC 표시) | 2026-11-18 | 39쪽 이미지 PDF(전부 OCR). 표·IP·모델·장 구성은 원본과 같음 | 사용자 결정 11/18: 실제 회사 문서(직원 이름·이메일 노출) → 가상판으로 교체, 원본 파일 삭제 | yoyo0704·dhxorb96 |
