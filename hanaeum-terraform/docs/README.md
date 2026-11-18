# hanaeum-terraform/docs

Terraform 구성의 아키텍처 그림. `prod-architecture.drawio`(편집용)·`prod-architecture.png`(보기용). 생성 기준: envs/prod 단일 환경 (11/19: dev 폐기, WAF 없음, OCR 최소1·최대1, 95% 미만 쪽 Vision 정리본, Finalize 노하우 재검증, protect_data=false. 그 전 11/18 13시 반영분 포함).
다시 만들기: `python3 gen_drawio.py prod-architecture.drawio` → draw.io 데스크톱 `draw.io -x -f png -s 1 -o prod-architecture.png prod-architecture.drawio`
