FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk fonts-noto-cjk-extra fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
