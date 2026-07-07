# 📍 FindMy Home

家に設置したWebカメラで、登録した持ち物（イヤホン・財布・鍵・スマホなど）をAIが探すWebアプリ。
スマホからアクセスして「🔍 探す」を押すだけで、対象物がカメラに映っているか・どこにあるかを確認できます。

## 構成（2層）

```
[スマホ / ブラウザ]                    [家のPC + Webカメラ(c922)]
  Next.js PWA (ルート直下) ─ HTTP/JSON ─▶  FastAPI エージェント (agent/)
  Vercelにデプロイ                          カメラ撮影 + AI照合(ONNX)
```

- **フロント（リポジトリ直下: `app/` `lib/` `public/` 等）** … Next.js (App Router) + TypeScript + Tailwind の PWA。Vercelにデプロイして、外出先・家の中どちらからでもスマホで操作。画面は「探す／登録／アイテム／設定」の4タブ。
- **agent/** … 家のPCで動かす Python FastAPI サーバー。Webカメラから画像を撮り、**MobileNetV2 (ONNX)** の1280次元特徴ベクトルで登録アイテムと照合する。データ（登録アイテム・画像）はこのPC内にのみ保存され、外部には出ません。
- **legacy/** … 旧v1（ブラウザ完結・TensorFlow.js版）。参考用に保管。

> Next.js アプリはリポジトリのルート直下にあります。Vercelは追加設定なし（Root Directory は既定のまま）で自動的に Next.js として認識・ビルドします。`agent/` と `legacy/` はビルド時に無視されます。

## AIのしくみ

MobileNetV2の分類結果ではなく、その手前の特徴ベクトル（埋め込み）を使う。

1. **登録**: 中央ガイド枠にアイテムを映して3枚以上撮影 → 各画像をベクトル化して保存
2. **探す**: カメラ映像を3スケールのスライディングウィンドウで切り出し → 各切り出しをベクトル化 → 登録ベクトルとのコサイン類似度がしきい値（既定70%）以上なら「見つかった」と判定し、位置に枠を描画

---

## セットアップ

### 1. 家のPC側: エージェントを起動

```bash
cd agent
python -m venv .venv && .venv\Scripts\activate   # 任意
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8300
# もしくは run.bat をダブルクリック
```

初回起動時に MobileNetV2 モデル（約14MB）を自動ダウンロードします。

環境変数（任意）:
- `FINDMY_API_KEY` … 設定すると `X-Api-Key` ヘッダー認証を要求（インターネット公開時は必須推奨）
- `FINDMY_CAMERA` … カメラのデバイスindex（既定 `0`）

### 2. スマホから使えるように公開（外出先から探すなら）

エージェントは家のPCのローカルサーバーなので、外から届くようにトンネルを張ります（[cloudflared](https://developers.cloudflare.com/cloudflare-tunnel/) 例）:

```bash
cloudflared tunnel --url http://localhost:8300
# → https://xxxx-xxxx.trycloudflare.com のようなURLが発行される
```

> **同じWi-Fi内だけで使う**なら公開は不要。`http://<PCのIPアドレス>:8300` を使えばOK。

### 3. Web（フロント）をVercelにデプロイ

VercelでGitHubリポジトリ `s1280061/findmy` をインポートするだけ。**Root Directory は既定（`./`）のまま**でOK。Framework は Next.js が自動検出されます（追加設定不要）。

Deploy後、発行されたURL（例 `https://findmy-xxxx.vercel.app`）をスマホで開く。

> ⚠️ Vercelの **Settings → Deployment Protection → Vercel Authentication** が ON だと、ログインした本人以外はアクセスできません。スマホから公開利用するなら **OFF** にしてください。

### 4. アプリで接続設定

1. スマホでVercelのURLを開く → 初回は「⚙️ 設定」タブが開く
2. **エージェントURL** に手順2のトンネルURL（またはローカルIP）を入力
3. APIキーを設定した場合は入力 → 「保存して接続テスト」→ ✅ 接続

（PWA対応。ブラウザの「ホーム画面に追加」でアプリのように使えます）

## ローカル開発（フロント）

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 本番ビルド確認
```

## 使い方

- **➕ 登録**: カメラ前の青い枠にアイテムを置き、角度を変えて3回以上「📸 撮影」→ 名前とアイコンを付けて「💾 保存」
- **🔍 探す**: 「探す」ボタンで、各アイテムが「✅ 見つかりました（一致度）＋発見位置の枠」か「❌ 見つかりません」を表示。「判定のきびしさ」で誤検出/見逃しを調整
- **📦 アイテム**: 登録済みの一覧・削除

## 精度を上げるコツ

- 登録は**実際に置きそうな場所と近い明るさ・背景**で、いろいろな角度から5〜8枚
- 小さい物（鍵など）はカメラに近いほど見つかりやすい
- MobileNetの汎用特徴量ベースなので、似た見た目の物との誤検出や暗所での見逃しあり。精度重視なら YOLOv8 / CLIP への差し替えも可能

## MVPの制限

- 単一Webカメラ・単一PC構成
- エージェントとWebは別々に起動が必要（Vercel = フロントのみ、AI処理は家のPC）
