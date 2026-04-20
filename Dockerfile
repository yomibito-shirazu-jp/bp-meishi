FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig wget curl gnupg \
    ca-certificates fonts-liberation libappindicator3-1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 \
    libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    lsb-release xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Vivliostyle CLI and md2pdf-ja globally
RUN npm install -g @vivliostyle/cli @j2masamitu/md2pdf-ja

# Download Google Fonts (Noto Sans JP / Noto Serif JP)
RUN mkdir -p /usr/share/fonts/google \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf" \
       -O /usr/share/fonts/google/NotoSansJP.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf" \
       -O /usr/share/fonts/google/NotoSerifJP.ttf \
    && fc-cache -fv

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# モリサワ等の商用フォントをコンテナにコピー
COPY fonts/ /app/fonts/
RUN fc-cache -fv

COPY backend/main.py .

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
