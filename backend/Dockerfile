FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk fonts-noto-cjk-extra fontconfig wget \
    && rm -rf /var/lib/apt/lists/*

# Download Google Fonts (Noto Sans JP / Noto Serif JP) — variable weight TTF
RUN mkdir -p /usr/share/fonts/google \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf" \
       -O /usr/share/fonts/google/NotoSansJP.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf" \
       -O /usr/share/fonts/google/NotoSerifJP.ttf \
    && fc-cache -fv

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
