@echo off
rem エージェント(localhost:8300)をHTTPSで一時公開するトンネル
rem 実行するとウィンドウに https://xxxx.trycloudflare.com のURLが表示される。
rem そのURLをスマホのアプリ「設定」タブに入力する。
rem ※ このウィンドウは開いたままにする（閉じると外からアクセスできなくなる）
rem ※ 再起動するとURLは毎回変わる
set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CF% set CF="C:\Program Files\cloudflared\cloudflared.exe"
%CF% tunnel --url http://localhost:8300 --no-autoupdate
