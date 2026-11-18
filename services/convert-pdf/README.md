# services/convert-pdf

단계 ConvertToPdf (사용자 결정 11/17 "모든 형식을 PDF 로 변환한 뒤 전부 OCR"). 원본 → `{doc}/work/document.pdf`.
LibreOffice headless 컨테이너 Lambda (arm64). 이미지는 terraform apply 가 CodeBuild(podman)로 빌드한다. 로컬 빌드 없음.
