@echo off
rem FindMy Home エージェント起動スクリプト
rem 事前に: pip install -r requirements.txt
cd /d %~dp0
rem 必要なら認証キーを設定（Webアプリの設定画面と同じ値にする）
rem set FINDMY_API_KEY=your-secret-key
rem set FINDMY_CAMERA=0
python -m uvicorn main:app --host 0.0.0.0 --port 8300
