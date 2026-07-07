// FindMy Home - 登録した持ち物を家のカメラから探すアプリ
// MobileNet の特徴ベクトル（埋め込み）を使い、登録写真とカメラ映像の
// スライディングウィンドウ切り抜きをコサイン類似度で照合する。

const STORAGE_KEY = "findmy_items";
const CROP_SIZE = 224;        // MobileNet 入力サイズ
const GUIDE_RATIO = 0.6;      // 登録時ガイド枠（画面短辺に対する比率）
const SCAN_SCALES = [0.35, 0.55, 0.8]; // 走査ウィンドウの短辺比率

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");

let model = null;
let items = loadItems();
let pendingShots = [];        // 登録中の撮影 { embedding: number[], thumb: dataURL }
let selectedIcon = "🎧";
let currentTab = "find";
let autoScanTimer = null;
let scanning = false;

// ---------- 初期化 ----------

async function init() {
  renderItems();
  await Promise.all([loadModel(), startCamera()]);
  requestAnimationFrame(drawOverlayLoop);
}

async function loadModel() {
  const status = document.getElementById("model-status");
  try {
    model = await mobilenet.load({ version: 2, alpha: 1.0 });
    status.innerHTML = "✅ AIモデル準備完了";
    status.classList.add("ready");
    document.getElementById("btn-find").disabled = items.length === 0;
    document.getElementById("btn-capture").disabled = false;
    setTimeout(() => (status.style.display = "none"), 2500);
  } catch (e) {
    console.error(e);
    status.innerHTML = "❌ AIモデルの読み込みに失敗しました。通信環境を確認して再読み込みしてください。";
    status.classList.add("error");
    status.querySelector(".spinner")?.remove();
  }
}

async function startCamera(deviceId) {
  const errBox = document.getElementById("camera-error");
  try {
    if (video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
    }
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await new Promise((res) => (video.onloadedmetadata = res));
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    errBox.classList.add("hidden");
    await populateCameraList();
  } catch (e) {
    console.error("camera error:", e);
    errBox.classList.remove("hidden");
  }
}

async function populateCameraList() {
  const select = document.getElementById("camera-select");
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const currentId = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  select.innerHTML = "";
  cams.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `カメラ ${i + 1}`;
    if (cam.deviceId === currentId) opt.selected = true;
    select.appendChild(opt);
  });
}

document.getElementById("camera-select").addEventListener("change", (e) => {
  startCamera(e.target.value);
});

// ---------- オーバーレイ描画（登録時のガイド枠） ----------

function drawOverlayLoop() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (currentTab === "register" && video.videoWidth > 0) {
    const g = guideRect();
    octx.strokeStyle = "#4f8cff";
    octx.lineWidth = 4;
    octx.setLineDash([12, 8]);
    octx.strokeRect(g.x, g.y, g.w, g.h);
    octx.setLineDash([]);
  }
  requestAnimationFrame(drawOverlayLoop);
}

function guideRect() {
  const w = video.videoWidth, h = video.videoHeight;
  const size = Math.min(w, h) * GUIDE_RATIO;
  return { x: (w - size) / 2, y: (h - size) / 2, w: size, h: size };
}

// ---------- 埋め込み計算 ----------

// canvas/画像から L2 正規化済み埋め込みベクトルを返す
async function embedImage(source) {
  return tf.tidy(() => {
    const img = tf.browser.fromPixels(source);
    const emb = model.infer(img, true); // [1, D]
    const norm = emb.div(emb.norm(2, 1, true));
    return norm;
  }).array().then((a) => a[0]);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // 正規化済みなので内積 = コサイン類似度
}

// ---------- 登録 ----------

document.querySelectorAll(".icon-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".icon-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedIcon = btn.dataset.icon;
  });
});

document.getElementById("btn-capture").addEventListener("click", async () => {
  if (!model || video.videoWidth === 0) return;
  const g = guideRect();
  const crop = document.createElement("canvas");
  crop.width = CROP_SIZE;
  crop.height = CROP_SIZE;
  crop.getContext("2d").drawImage(video, g.x, g.y, g.w, g.h, 0, 0, CROP_SIZE, CROP_SIZE);

  const thumbC = document.createElement("canvas");
  thumbC.width = 96;
  thumbC.height = 96;
  thumbC.getContext("2d").drawImage(crop, 0, 0, 96, 96);

  const embedding = await embedImage(crop);
  pendingShots.push({ embedding, thumb: thumbC.toDataURL("image/jpeg", 0.7) });
  renderPendingShots();
  flashOverlay();
});

function flashOverlay() {
  octx.fillStyle = "rgba(255,255,255,0.5)";
  octx.fillRect(0, 0, overlay.width, overlay.height);
}

function renderPendingShots() {
  const box = document.getElementById("captured-shots");
  box.innerHTML = "";
  pendingShots.forEach((shot, i) => {
    const div = document.createElement("div");
    div.className = "shot";
    div.innerHTML = `<img src="${shot.thumb}" alt="撮影${i + 1}">
      <button class="shot-del" data-i="${i}">✕</button>`;
    box.appendChild(div);
  });
  box.querySelectorAll(".shot-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingShots.splice(Number(btn.dataset.i), 1);
      renderPendingShots();
    });
  });
  const needed = Math.max(0, 3 - pendingShots.length);
  const saveBtn = document.getElementById("btn-save-item");
  saveBtn.disabled = needed > 0;
  saveBtn.innerHTML = needed > 0 ? `💾 保存（あと${needed}枚）` : "💾 保存";
}

document.getElementById("btn-save-item").addEventListener("click", () => {
  const name = document.getElementById("item-name").value.trim();
  if (!name) {
    alert("アイテム名を入力してください");
    return;
  }
  if (pendingShots.length < 3) return;
  items.push({
    id: Date.now().toString(36),
    name,
    icon: selectedIcon,
    embeddings: pendingShots.map((s) => s.embedding.map((v) => Math.round(v * 10000) / 10000)),
    thumb: pendingShots[0].thumb,
  });
  saveItems();
  pendingShots = [];
  document.getElementById("item-name").value = "";
  renderPendingShots();
  renderItems();
  document.getElementById("btn-find").disabled = !model;
  switchTab("items");
});

// ---------- アイテム一覧 ----------

function renderItems() {
  const list = document.getElementById("item-list");
  if (items.length === 0) {
    list.innerHTML = `<p class="empty-msg">まだアイテムが登録されていません。<br>「➕ 登録」タブから持ち物を登録しましょう。</p>`;
    return;
  }
  list.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="r-icon">${item.icon}</span>
      <img src="${item.thumb}" alt="${item.name}">
      <div class="i-body">
        <div class="i-name">${escapeHtml(item.name)}</div>
        <div class="i-meta">登録写真 ${item.embeddings.length}枚</div>
      </div>
      <button class="i-del" data-id="${item.id}">削除</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".i-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items.find((it) => it.id === btn.dataset.id);
      if (confirm(`「${item.name}」を削除しますか？`)) {
        items = items.filter((it) => it.id !== btn.dataset.id);
        saveItems();
        renderItems();
        document.getElementById("btn-find").disabled = items.length === 0 || !model;
      }
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    alert("保存容量が足りません。不要なアイテムを削除してください。");
  }
}

// ---------- 探す ----------

document.getElementById("threshold").addEventListener("input", (e) => {
  document.getElementById("threshold-val").textContent = e.target.value;
});

document.getElementById("btn-find").addEventListener("click", () => scanOnce());

document.getElementById("auto-scan").addEventListener("change", (e) => {
  if (e.target.checked) {
    scanOnce();
    autoScanTimer = setInterval(scanOnce, 2000);
  } else {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
});

// 走査ウィンドウ（正規化座標 [y1,x1,y2,x2]）を生成
function genScanBoxes(w, h) {
  const boxes = [];
  const minDim = Math.min(w, h);
  for (const scale of SCAN_SCALES) {
    const size = minDim * scale;
    const stride = size * 0.5;
    const nx = Math.max(1, Math.round((w - size) / stride) + 1);
    const ny = Math.max(1, Math.round((h - size) / stride) + 1);
    for (let iy = 0; iy < ny; iy++) {
      const y = ny === 1 ? (h - size) / 2 : ((h - size) * iy) / (ny - 1);
      for (let ix = 0; ix < nx; ix++) {
        const x = nx === 1 ? (w - size) / 2 : ((w - size) * ix) / (nx - 1);
        boxes.push([y / h, x / w, (y + size) / h, (x + size) / w]);
      }
    }
  }
  boxes.push([0, 0, 1, 1]); // 全体フレームも1枚
  return boxes;
}

async function scanOnce() {
  if (scanning || !model || video.videoWidth === 0 || items.length === 0) return;
  scanning = true;
  const statusEl = document.getElementById("scan-status");
  statusEl.textContent = "🔎 スキャン中...";
  const t0 = performance.now();

  try {
    const w = video.videoWidth, h = video.videoHeight;
    const boxes = genScanBoxes(w, h);

    // フレームを一括で切り抜き → バッチで埋め込み計算
    const cropEmbs = await tf.tidy(() => {
      const frame = tf.browser.fromPixels(video).expandDims(0).toFloat();
      const crops = tf.image.cropAndResize(
        frame,
        tf.tensor2d(boxes),
        tf.zeros([boxes.length], "int32"),
        [CROP_SIZE, CROP_SIZE]
      );
      const emb = model.infer(crops, true); // [N, D]
      return emb.div(emb.norm(2, 1, true));
    }).array();

    // 判定用スナップショットを保存
    const snap = document.createElement("canvas");
    snap.width = w;
    snap.height = h;
    snap.getContext("2d").drawImage(video, 0, 0);

    const threshold = Number(document.getElementById("threshold").value) / 100;
    const results = items.map((item) => {
      let best = { score: -1, boxIdx: 0 };
      for (let bi = 0; bi < cropEmbs.length; bi++) {
        for (const ref of item.embeddings) {
          const s = cosine(cropEmbs[bi], ref);
          if (s > best.score) best = { score: s, boxIdx: bi };
        }
      }
      return { item, score: best.score, box: boxes[best.boxIdx], found: best.score >= threshold };
    });

    renderResults(results, snap);
    const ms = Math.round(performance.now() - t0);
    const foundCount = results.filter((r) => r.found).length;
    statusEl.textContent =
      foundCount > 0
        ? `✅ ${foundCount}個 見つかりました（${ms}ms）`
        : `見つかりませんでした（${ms}ms）。カメラの向きや明るさを変えて再度お試しください。`;
  } catch (e) {
    console.error(e);
    statusEl.textContent = "⚠️ スキャンに失敗しました";
  } finally {
    scanning = false;
  }
}

function renderResults(results, snap) {
  const box = document.getElementById("find-results");
  box.innerHTML = "";
  results
    .sort((a, b) => b.score - a.score)
    .forEach((r) => {
      const card = document.createElement("div");
      card.className = `result-card ${r.found ? "found" : "notfound"}`;
      let imgHtml = "";
      if (r.found) {
        imgHtml = `<img src="${markedSnapshot(snap, r.box)}" alt="発見場所">`;
      }
      card.innerHTML = `
        <span class="r-icon">${r.item.icon}</span>
        <div class="r-body">
          <div class="r-name">${escapeHtml(r.item.name)}</div>
          <div class="r-status">${
            r.found
              ? `✅ 見つかりました（一致度 ${(r.score * 100).toFixed(0)}%）`
              : `❌ 見つかりません（最大一致度 ${(r.score * 100).toFixed(0)}%）`
          }</div>
        </div>
        ${imgHtml}`;
      box.appendChild(card);
    });
}

// スナップショットに発見位置の枠を描いた画像を返す
function markedSnapshot(snap, normBox) {
  const c = document.createElement("canvas");
  c.width = snap.width;
  c.height = snap.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(snap, 0, 0);
  const [y1, x1, y2, x2] = normBox;
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = Math.max(4, snap.width / 120);
  ctx.strokeRect(x1 * snap.width, y1 * snap.height, (x2 - x1) * snap.width, (y2 - y1) * snap.height);
  return c.toDataURL("image/jpeg", 0.75);
}

// ---------- タブ切り替え ----------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["find", "register", "items"].forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  if (tab !== "find" && autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
    document.getElementById("auto-scan").checked = false;
  }
}

init();
