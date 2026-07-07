"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addItem,
  deleteItem,
  embedImageUpload,
  health,
  listItems,
  loadSettings,
  saveSettings,
  scan,
  type ItemSummary,
  type ScanResult,
  type Settings,
} from "@/lib/agent";

type Tab = "find" | "register" | "items" | "settings";

const ICONS = ["🎧", "📱", "👛", "🔑", "⌚", "🎮"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("find");
  const [settings, setSettings] = useState<Settings>({ url: "", apiKey: "" });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);

  // 初期化: 設定読み込み → 接続確認
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    if (s.url) {
      checkConnection(s);
    } else {
      setConnected(false);
      setTab("settings");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkConnection = useCallback(async (s: Settings) => {
    try {
      await health(s);
      setConnected(true);
      setItems(await listItems(s));
      return true;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  const refreshItems = useCallback(async () => {
    try {
      setItems(await listItems(settings));
    } catch {}
  }, [settings]);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 pb-24">
      <header className="py-5 text-center">
        <h1 className="text-2xl font-bold">📍 FindMy Home</h1>
        <p className="mt-1 text-sm text-slate-400">家のカメラで持ち物を探す</p>
        {connected === false && settings.url && (
          <p className="mt-2 rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-400">
            ⚠️ エージェントに接続できません。設定を確認してください。
          </p>
        )}
      </header>

      <main className="flex-1">
        {tab === "find" && (
          <FindTab settings={settings} items={items} connected={connected === true} />
        )}
        {tab === "register" && (
          <RegisterTab
            settings={settings}
            connected={connected === true}
            onSaved={() => {
              refreshItems();
              setTab("items");
            }}
          />
        )}
        {tab === "items" && (
          <ItemsTab settings={settings} items={items} onChanged={refreshItems} />
        )}
        {tab === "settings" && (
          <SettingsTab
            settings={settings}
            onSave={async (s) => {
              setSettings(s);
              saveSettings(s);
              const ok = await checkConnection(s);
              if (ok) setTab("find");
              return ok;
            }}
          />
        )}
      </main>

      {/* 下部ナビ */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-slate-800 bg-[#141a2a]/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          {(
            [
              ["find", "🔍", "探す"],
              ["register", "➕", "登録"],
              ["items", "📦", "アイテム"],
              ["settings", "⚙️", "設定"],
            ] as [Tab, string, string][]
          ).map(([t, icon, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-3 text-center text-xs ${
                tab === t ? "text-blue-400" : "text-slate-500"
              }`}
            >
              <span className="block text-xl">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ---------- 探す ----------

function FindTab({
  settings,
  items,
  connected,
}: {
  settings: Settings;
  items: ItemSummary[];
  connected: boolean;
}) {
  const [threshold, setThreshold] = useState(70);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");

  const doScan = async () => {
    setScanning(true);
    setError("");
    try {
      setResult(await scan(settings, threshold / 100));
    } catch (e) {
      setError(e instanceof Error ? e.message : "スキャンに失敗しました");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={doScan}
        disabled={!connected || scanning || items.length === 0}
        className="w-full rounded-2xl bg-blue-600 py-5 text-xl font-bold text-white transition active:scale-[0.98] disabled:opacity-40"
      >
        {scanning ? "🔎 スキャン中..." : "🔍 探す"}
      </button>
      {items.length === 0 && connected && (
        <p className="text-center text-sm text-slate-400">
          まず「➕ 登録」タブでアイテムを登録してください
        </p>
      )}

      <label className="flex items-center gap-3 text-sm text-slate-400">
        判定のきびしさ: <b className="text-slate-200">{threshold}%</b>
        <input
          type="range"
          min={50}
          max={90}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="flex-1 accent-blue-500"
        />
      </label>

      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-400">⚠️ {error}</p>}

      {result && (
        <div className="space-y-3">
          <p className="text-center text-sm text-slate-400">
            {result.results.filter((r) => r.found).length > 0
              ? `✅ ${result.results.filter((r) => r.found).length}個 見つかりました（${result.elapsed_ms}ms）`
              : "見つかりませんでした。カメラの向きや明るさを確認してください。"}
          </p>
          {/* 注釈付きスナップショット + アイテム名オーバーレイ */}
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.image} alt="スキャン結果" className="w-full rounded-2xl" />
            {result.results
              .filter((r) => r.found)
              .map((r) => (
                <span
                  key={r.id}
                  className="absolute -translate-y-full rounded-md bg-emerald-500/90 px-2 py-0.5 text-xs font-bold text-black"
                  style={{ left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%` }}
                >
                  {r.icon} {r.name}
                </span>
              ))}
          </div>
          <div className="space-y-2">
            {result.results.map((r) => (
              <div
                key={r.id}
                className={`flex items-center gap-3 rounded-xl bg-[#1a2233] p-4 border-l-4 ${
                  r.found ? "border-emerald-400" : "border-red-400"
                }`}
              >
                <span className="text-3xl">{r.icon}</span>
                <div>
                  <div className="font-bold">{r.name}</div>
                  <div className={`text-sm ${r.found ? "text-emerald-400" : "text-red-400"}`}>
                    {r.found
                      ? `✅ 見つかりました（一致度 ${(r.score * 100).toFixed(0)}%）`
                      : `❌ 見つかりません（最大一致度 ${(r.score * 100).toFixed(0)}%）`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 登録（スマホのカメラで撮影） ----------

function RegisterTab({
  settings,
  connected,
  onSaved,
}: {
  settings: Settings;
  connected: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(ICONS[0]);
  const [shots, setShots] = useState<{ embedding: number[]; thumb: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [camError, setCamError] = useState("");
  const [camReady, setCamReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // スマホの背面カメラを起動（HTTPS必須。Vercel/localhostならOK）
  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCamReady(true);
        }
      } catch {
        setCamError("カメラを起動できません。ブラウザのカメラ許可を確認してください。");
      }
    })();
    return () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // 現在のフレームを中央正方形で切り出し → エージェントで埋め込み計算
  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setBusy(true);
    setError("");
    try {
      const w = video.videoWidth,
        h = video.videoHeight;
      const side = Math.min(w, h);
      const c = document.createElement("canvas");
      c.width = side;
      c.height = side;
      c.getContext("2d")!.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, side, side);
      const dataUrl = c.toDataURL("image/jpeg", 0.85);
      const shot = await embedImageUpload(settings, dataUrl);
      setShots((s) => [...s, shot]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撮影に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setError("アイテム名を入力してください");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addItem(settings, {
        name: name.trim(),
        icon,
        embeddings: shots.map((s) => s.embedding),
        thumb: shots[0].thumb,
      });
      setName("");
      setShots([]);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const needed = Math.max(0, 3 - shots.length);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-slate-400">
        <b className="text-slate-200">スマホのカメラ</b>で持ち物を枠いっぱいに映し、角度を変えながら{" "}
        <b className="text-slate-200">3回以上</b> 撮影してください。（探すのは家のカメラ、登録はこのスマホで撮ります）
      </p>

      {/* スマホカメラのライブプレビュー（正方形＝撮影範囲） */}
      <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {camReady && <div className="pointer-events-none absolute inset-3 rounded-xl border-4 border-dashed border-blue-400" />}
        {camError && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-400">
            {camError}
          </div>
        )}
        {!camReady && !camError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            カメラを起動中...
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm text-slate-400">
        アイコン:
        {ICONS.map((ic) => (
          <button
            key={ic}
            onClick={() => setIcon(ic)}
            className={`rounded-lg px-2 py-1 text-xl ${
              icon === ic ? "bg-[#232e45] ring-2 ring-blue-500" : "bg-[#1a2233]"
            }`}
          >
            {ic}
          </button>
        ))}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={20}
        placeholder="アイテム名（例: AirPods）"
        className="w-full rounded-xl border border-slate-700 bg-[#1a2233] px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500"
      />

      <div className="flex gap-3">
        <button
          onClick={capture}
          disabled={!connected || busy || !camReady}
          className="flex-1 rounded-xl bg-[#232e45] py-3 font-bold disabled:opacity-40"
        >
          📸 撮影
        </button>
        <button
          onClick={save}
          disabled={!connected || busy || needed > 0}
          className="flex-1 rounded-xl bg-blue-600 py-3 font-bold disabled:opacity-40"
        >
          {needed > 0 ? `💾 保存（あと${needed}枚）` : "💾 保存"}
        </button>
      </div>

      {!connected && (
        <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-400">
          ⚠️ エージェント未接続です。「⚙️設定」でURL・APIキーを設定してください。
        </p>
      )}
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-400">⚠️ {error}</p>}

      {shots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shots.map((s, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.thumb} alt={`撮影${i + 1}`} className="h-20 w-20 rounded-lg object-cover" />
              <button
                onClick={() => setShots(shots.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs text-white"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- アイテム一覧 ----------

function ItemsTab({
  settings,
  items,
  onChanged,
}: {
  settings: Settings;
  items: ItemSummary[];
  onChanged: () => void;
}) {
  const [error, setError] = useState("");

  const remove = async (item: ItemSummary) => {
    if (!confirm(`「${item.name}」を削除しますか？`)) return;
    try {
      await deleteItem(settings, item.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  if (items.length === 0) {
    return (
      <p className="py-10 text-center text-sm leading-relaxed text-slate-400">
        まだアイテムが登録されていません。
        <br />
        「➕ 登録」タブから持ち物を登録しましょう。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-400">⚠️ {error}</p>}
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-4 rounded-xl bg-[#1a2233] p-4">
          <span className="text-3xl">{item.icon}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.thumb} alt={item.name} className="h-14 w-14 rounded-lg object-cover" />
          <div className="flex-1">
            <div className="font-bold">{item.name}</div>
            <div className="text-xs text-slate-400">登録写真 {item.shots}枚</div>
          </div>
          <button
            onClick={() => remove(item)}
            className="rounded-lg border border-red-400 px-3 py-2 text-sm text-red-400"
          >
            削除
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- 設定 ----------

function SettingsTab({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<boolean>;
}) {
  const [url, setUrl] = useState(settings.url);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "ng">("idle");

  useEffect(() => {
    setUrl(settings.url);
    setApiKey(settings.apiKey);
  }, [settings]);

  const save = async () => {
    setStatus("testing");
    const ok = await onSave({ url: url.trim(), apiKey: apiKey.trim() });
    setStatus(ok ? "ok" : "ng");
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-slate-400">エージェントURL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://xxxx.trycloudflare.com"
          className="w-full rounded-xl border border-slate-700 bg-[#1a2233] px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          家のPCで起動したエージェントのURL。同じネットワーク内なら http://
          &lt;PCのIP&gt;:8300、外出先からは cloudflared などのトンネルURLを入力。
        </p>
      </div>
      <div>
        <label className="mb-1 block text-sm text-slate-400">APIキー（エージェント側で設定した場合）</label>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="未設定なら空欄"
          className="w-full rounded-xl border border-slate-700 bg-[#1a2233] px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        onClick={save}
        disabled={!url.trim() || status === "testing"}
        className="w-full rounded-xl bg-blue-600 py-3 font-bold disabled:opacity-40"
      >
        {status === "testing" ? "接続確認中..." : "保存して接続テスト"}
      </button>
      {status === "ok" && <p className="text-center text-sm text-emerald-400">✅ 接続しました</p>}
      {status === "ng" && (
        <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm leading-relaxed text-red-400">
          ⚠️ 接続できません。エージェントが起動しているか、URL・APIキーが正しいか確認してください。
        </p>
      )}
    </div>
  );
}
