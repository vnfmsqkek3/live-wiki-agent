# 공유 dev 갱신 예고: dhxorb96 32e5f81, ImageDescribe, freshness-sweep, 스트리밍 설정

| 항목 | 내용 |
|---|---|
| 상태 | 진행중 (약 20분) |
| 커밋 | dhxorb96·웹·API `32e5f81`, yoyo0704 `78d8355`, let522mj `ce47b15` (그대로) |
| 추가 | 단계 Lambda `image-describe`(PiiScan 뒤, model-caller), Gateway Target·permit 먼저 → Runtime `IMAGE_DESCRIBE=on` |
| 추가 | `freshness-sweep` + Scheduler 매일 00:00 KST, 스트리밍(CloudFront /v1/* 압축 끔·origin read 60초, ALB idle 300초) |
| 변경 없음 | OCR 엔드포인트(`ocr_source_ref` 분리), KB 데이터 소스 |
| 요청 | 끝날 때까지 파이프라인 실행 피하기. 끝나면 smoke·ALLOW/DENY 결과 기록 |
