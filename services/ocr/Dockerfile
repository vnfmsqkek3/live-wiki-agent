# ECR Public 미러 사용 (Docker Hub 익명 pull 제한 회피)
FROM public.ecr.aws/docker/library/python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 3.x GPU wheel 은 CUDA·cuDNN 을 nvidia-* pip 패키지로 받는다 (호스트 드라이버만 필요)
RUN pip install --no-cache-dir paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/ \
    && pip install --no-cache-dir paddleocr==3.7.0 boto3==1.44.3

ENV PADDLE_PDX_CACHE_HOME=/opt/models PYTHONUNBUFFERED=1
WORKDIR /opt/app
COPY convert.py serve.py ./
EXPOSE 8080
ENTRYPOINT ["python", "serve.py"]
