# AWS DLC SageMaker GPU 이미지 (CUDA 11.8 + NVIDIA 런타임 설정 포함). cu118 계열 DLC 최신(2.2.0).
# 참고 구현(megazone-idp paddleocr-model-builder)과 같은 베이스.
# python:3.12-slim + cu126 wheel 은 SageMaker 에서 GPU 를 인식하지 못했음 (트러블슈팅 11/16)
FROM 763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.2.0-gpu-py310-cu118-ubuntu20.04-sagemaker

RUN apt-get update && apt-get install -y --no-install-recommends libgl1-mesa-glx libglib2.0-0 libsm6 libxext6 libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

# cu118 계열 최신 paddle (3.4.0 은 cu129·cu130 만 제공). paddle CDN 은 해외에서 느려 timeout·재시도를 늘린다
RUN pip install --no-cache-dir --timeout 300 --retries 10 paddlepaddle-gpu==3.3.1 \
      --extra-index-url https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
    && pip install --no-cache-dir --timeout 300 --retries 10 paddleocr==3.7.0 paddlex==3.7.2

ENV PADDLE_PDX_CACHE_HOME=/opt/models PYTHONUNBUFFERED=1
WORKDIR /opt/app
COPY convert.py serve.py ./
EXPOSE 8080
ENTRYPOINT ["python", "serve.py"]
