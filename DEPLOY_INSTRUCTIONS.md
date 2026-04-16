# デプロイ手順

## 変更済みファイル（4ファイル）
1. `backend/main.py` — pct-bbox座標フォールバック追加（画像内テキスト編集対応）
2. `App.tsx` — x_pct/y_pct/w_pct/h_pctをoverridesに送信
3. `services/api.ts` — SpanOverrideインターフェースにpct座標追加
4. `.gitignore` — backend/venv/追加

## デプロイコマンド

```bash
# 1. コミット＆プッシュ
cd bp-meishi
git add backend/main.py App.tsx services/api.ts .gitignore
git commit -m "fix: 画像内テキスト編集対応 - pct-bbox座標フォールバック追加"
git push origin main

# 2. バックエンドデプロイ（Cloud Build）
gcloud builds submit --config=cloudbuild-api.yaml --project=YOUR_PROJECT_ID

# 3. フロントエンドデプロイ（Cloud Build）
gcloud builds submit --config=cloudbuild.yaml --project=YOUR_PROJECT_ID
```
