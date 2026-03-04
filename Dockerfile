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
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Local fonts (欧文 + 和文主要フォント) ──
# 欧文フォント (~15 MB)
COPY fonts/AmericanTypewriter/ /app/fonts/AmericanTypewriter/
COPY fonts/AvantGarde/         /app/fonts/AvantGarde/
COPY fonts/Avenir/             /app/fonts/Avenir/
COPY fonts/Bembo/              /app/fonts/Bembo/
COPY fonts/Blackoak/           /app/fonts/Blackoak/
COPY fonts/Bodoni/             /app/fonts/Bodoni/
COPY fonts/Bookman/            /app/fonts/Bookman/
COPY fonts/Century/            /app/fonts/Century/
COPY fonts/Copperplate/        /app/fonts/Copperplate/
COPY fonts/DIN/                /app/fonts/DIN/
COPY fonts/Formata/            /app/fonts/Formata/
COPY fonts/Frutiger/           /app/fonts/Frutiger/
COPY fonts/Futura/             /app/fonts/Futura/
COPY fonts/Galliard/           /app/fonts/Galliard/
COPY fonts/Garamond/           /app/fonts/Garamond/
COPY fonts/Helvetica/          /app/fonts/Helvetica/
COPY fonts/Janson/             /app/fonts/Janson/
COPY fonts/Kaufmann/           /app/fonts/Kaufmann/
COPY fonts/Kuenstler/          /app/fonts/Kuenstler/
COPY fonts/LubalinGraph/       /app/fonts/LubalinGraph/
COPY fonts/Memphis/            /app/fonts/Memphis/
COPY fonts/NeuzeitS/           /app/fonts/NeuzeitS/
COPY fonts/OCR/                /app/fonts/OCR/
COPY "fonts/Rockwell Extra Bold/" "/app/fonts/Rockwell Extra Bold/"
COPY fonts/Symbol/             /app/fonts/Symbol/
COPY fonts/Syntax/             /app/fonts/Syntax/
COPY fonts/TemplateGothic/     /app/fonts/TemplateGothic/
COPY fonts/Tiffany/            /app/fonts/Tiffany/
COPY fonts/Times/              /app/fonts/Times/
COPY fonts/Typeka/             /app/fonts/Typeka/
COPY fonts/Univers/            /app/fonts/Univers/
COPY fonts/VAGRounded/         /app/fonts/VAGRounded/
COPY fonts/Wingdings/          /app/fonts/Wingdings/
COPY fonts/ZapfDingbats/       /app/fonts/ZapfDingbats/

# 和文主要フォント — モリサワ Pro版 主要ウェイト (~78 MB)
RUN mkdir -p /app/fonts/Morisawa
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-GothicBBBPro-Medium.otf"    /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-GothicMB101Pro-Reg.otf"     /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-GothicMB101Pro-Bold.otf"    /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-GothicMB101Pro-Medium.otf"  /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-GothicMB101Pro-Light.otf"   /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-RyuminPro-Light.otf"        /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-RyuminPro-Medium.otf"       /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-RyuminPro-Bold.otf"         /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-ShinGoPro-Light.otf"        /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-ShinGoPro-Medium.otf"       /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-ShinGoPro-Bold.otf"         /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-FutoGoB101Pro-Bold.otf"     /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-FutoMinA101Pro-Bold.otf"    /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-Jun101Pro-Light.otf"        /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-Jun501Pro-Bold.otf"         /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-MaruFoPro-Bold.otf"         /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-MaruFoPro-Medium.otf"       /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-KakuminPro-Medium.otf"      /app/fonts/Morisawa/
COPY "fonts/和文書体（モリサワ、フォントワークス）/A-OTF-KakuminPro-Bold.otf"        /app/fonts/Morisawa/

COPY backend/main.py .

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
