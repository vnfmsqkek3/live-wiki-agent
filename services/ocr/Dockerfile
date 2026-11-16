# ECR Public 미러 사용 (Docker Hub 익명 pull 제한 회피)
FROM public.ecr.aws/docker/library/python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 3.x GPU wheel 은 CUDA·cuDNN 을 nvidia-* pip 패키지로 받는다 (호스트 드라이버만 필요)
# paddle CDN(bcebos) 은 해외에서 느려 timeout·재시도를 늘린다 (트러블슈팅 11/16)
RUN pip install --no-cache-dir --timeout 300 --retries 10 paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/ \
    && pip install --no-cache-dir paddleocr==3.7.0 boto3==1.44.3

# slim 이미지는 CUDA 베이스가 아니라 NVIDIA 런타임이 드라이버를 붙이도록 직접 지정해야 GPU 가 보인다
ENV PADDLE_PDX_CACHE_HOME=/opt/models PYTHONUNBUFFERED=1 \
    NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
WORKDIR /opt/app
COPY convert.py serve.py ./
EXPOSE 8080
ENTRYPOINT ["python", "serve.py"]
