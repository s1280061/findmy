// ローカルエージェント（家のPCのFastAPI）との通信クライアント

export type Settings = {
  url: string; // 例: https://xxxx.trycloudflare.com または http://localhost:8300
  apiKey: string;
};

export type ItemSummary = {
  id: string;
  name: string;
  icon: string;
  thumb: string;
  shots: number;
};

export type ScanResult = {
  results: {
    id: string;
    name: string;
    icon: string;
    found: boolean;
    score: number;
    box: { x: number; y: number; w: number; h: number };
  }[];
  image: string; // 注釈付きJPEG dataURL
  elapsed_ms: number;
};

const SETTINGS_KEY = "findmy_settings";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return { url: "", apiKey: "" };
  try {
    return { url: "", apiKey: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { url: "", apiKey: "" };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function base(s: Settings): string {
  return s.url.replace(/\/+$/, "");
}

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (s.apiKey) h["X-Api-Key"] = s.apiKey;
  return h;
}

async function req(s: Settings, path: string, init?: RequestInit) {
  const res = await fetch(base(s) + path, { ...init, headers: { ...headers(s), ...(init?.headers as Record<string, string>) } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.detail) detail = j.detail;
    } catch {}
    throw new Error(detail);
  }
  return res;
}

export async function health(s: Settings): Promise<{ ok: boolean; items: number; auth: boolean }> {
  const res = await req(s, "/health");
  return res.json();
}

// <img> はヘッダーを送れないため、blob で取得して objectURL を返す
export async function fetchSnapshot(s: Settings): Promise<string> {
  const res = await req(s, "/snapshot");
  return URL.createObjectURL(await res.blob());
}

export async function embedCenter(s: Settings): Promise<{ embedding: number[]; thumb: string }> {
  const res = await req(s, "/embed_center", { method: "POST" });
  return res.json();
}

// スマホ等で撮影した画像を送って埋め込みを計算してもらう（登録用）
export async function embedImageUpload(
  s: Settings,
  imageDataUrl: string
): Promise<{ embedding: number[]; thumb: string }> {
  const res = await req(s, "/embed_image", { method: "POST", body: JSON.stringify({ image: imageDataUrl }) });
  return res.json();
}

export async function listItems(s: Settings): Promise<ItemSummary[]> {
  const res = await req(s, "/items");
  return res.json();
}

export async function addItem(
  s: Settings,
  item: { name: string; icon: string; embeddings: number[][]; thumb: string }
): Promise<void> {
  await req(s, "/items", { method: "POST", body: JSON.stringify(item) });
}

export async function deleteItem(s: Settings, id: string): Promise<void> {
  await req(s, `/items/${id}`, { method: "DELETE" });
}

export async function scan(s: Settings, threshold: number): Promise<ScanResult> {
  const res = await req(s, "/scan", { method: "POST", body: JSON.stringify({ threshold }) });
  return res.json();
}
