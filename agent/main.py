"""FindMy Home ローカルエージェント

家のPCに接続されたWebカメラ（c922等）から画像を取得し、
MobileNetV2 (ONNX) の特徴ベクトルで登録アイテムと照合するFastAPIサーバー。

起動:  python -m uvicorn main:app --host 0.0.0.0 --port 8300
環境変数:
  FINDMY_API_KEY  設定すると X-Api-Key ヘッダーによる認証を要求
  FINDMY_CAMERA   カメラのデバイスインデックス（既定 0）
"""

import base64
import json
import os
import threading
import time
import uuid
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
DATA_FILE = BASE / "items.json"
MODEL_FILE = BASE / "mobilenetv2_emb.onnx"

API_KEY = os.environ.get("FINDMY_API_KEY", "")
CAMERA_INDEX = int(os.environ.get("FINDMY_CAMERA", "0"))

CROP = 224                      # MobileNet 入力サイズ
GUIDE_RATIO = 0.6               # 登録時の中央ガイド枠（短辺比）
SCAN_SCALES = [0.35, 0.55, 0.8]  # 走査ウィンドウの短辺比率
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# ---------- モデル準備（初回起動時に自動ダウンロード＋埋め込み出力を追加） ----------

MODEL_URL = ("https://github.com/onnx/models/raw/main/validated/vision/"
             "classification/mobilenet/model/mobilenetv2-12.onnx")


def prepare_model() -> Path:
    if MODEL_FILE.exists():
        return MODEL_FILE
    import urllib.request

    import onnx

    raw = BASE / "mobilenetv2-12.onnx"
    if not raw.exists():
        print(f"[setup] モデルをダウンロード中... {MODEL_URL}")
        urllib.request.urlretrieve(MODEL_URL, raw)
    print("[setup] GlobalAveragePool 出力を埋め込みとして公開するようパッチ中...")
    model = onnx.load(str(raw))
    gap_output = None
    for node in model.graph.node:
        if node.op_type == "GlobalAveragePool":
            gap_output = node.output[0]
    if gap_output is None:
        raise RuntimeError("GlobalAveragePool ノードが見つかりません")
    emb_info = onnx.helper.make_tensor_value_info(
        gap_output, onnx.TensorProto.FLOAT, None)
    model.graph.output.append(emb_info)
    onnx.save(model, str(MODEL_FILE))
    print(f"[setup] 完了: {MODEL_FILE.name} (embedding output: {gap_output})")
    return MODEL_FILE


prepare_model()
_sess = ort.InferenceSession(str(MODEL_FILE), providers=["CPUExecutionProvider"])
INPUT_NAME = _sess.get_inputs()[0].name
EMB_NAME = _sess.get_outputs()[-1].name  # 追加した GlobalAveragePool 出力


def embed_batch(crops_bgr: list) -> np.ndarray:
    """224x224 BGR 画像のリストから L2 正規化済み埋め込み [N, D] を返す"""
    arr = np.stack(crops_bgr).astype(np.float32)[:, :, :, ::-1] / 255.0  # → RGB
    arr = (arr - MEAN) / STD
    arr = np.ascontiguousarray(arr.transpose(0, 3, 1, 2))
    try:
        out = _sess.run([EMB_NAME], {INPUT_NAME: arr})[0]
    except Exception:
        # バッチ非対応モデルの場合は1枚ずつ
        outs = [_sess.run([EMB_NAME], {INPUT_NAME: arr[i:i + 1]})[0]
                for i in range(arr.shape[0])]
        out = np.concatenate(outs, axis=0)
    emb = out.reshape(out.shape[0], -1)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9
    return emb


# ---------- カメラ ----------

class Camera:
    def __init__(self, index: int):
        self.index = index
        self.cap = None
        self.lock = threading.Lock()

    def _ensure(self):
        if self.cap is None or not self.cap.isOpened():
            self.cap = cv2.VideoCapture(self.index, cv2.CAP_DSHOW)
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            time.sleep(0.3)  # 露出安定待ち

    def read(self) -> np.ndarray:
        with self.lock:
            self._ensure()
            for _ in range(3):  # バッファ内の古いフレームを捨てる
                self.cap.grab()
            ok, frame = self.cap.read()
            if not ok or frame is None:
                if self.cap is not None:
                    self.cap.release()
                self.cap = None
                raise HTTPException(503, "カメラから画像を取得できません")
            return frame


camera = Camera(CAMERA_INDEX)

# ---------- アイテム永続化 ----------

_items_lock = threading.Lock()


def load_items() -> list:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return []


def save_items(items: list):
    DATA_FILE.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")


# ---------- ユーティリティ ----------

def to_jpeg(frame: np.ndarray, quality: int = 75, max_width: int = 960) -> bytes:
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, int(h * max_width / w)))
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()


def to_data_url(frame: np.ndarray, quality: int = 75, max_width: int = 960) -> str:
    return ("data:image/jpeg;base64,"
            + base64.b64encode(to_jpeg(frame, quality, max_width)).decode())


def center_guide_rect(w: int, h: int):
    size = int(min(w, h) * GUIDE_RATIO)
    return (w - size) // 2, (h - size) // 2, size


def gen_scan_boxes(w: int, h: int) -> list:
    """走査ウィンドウ (x, y, size) のリスト（ピクセル座標）"""
    boxes = []
    min_dim = min(w, h)
    for scale in SCAN_SCALES:
        size = int(min_dim * scale)
        stride = size // 2
        nx = max(1, round((w - size) / stride) + 1)
        ny = max(1, round((h - size) / stride) + 1)
        for iy in range(ny):
            y = (h - size) // 2 if ny == 1 else int((h - size) * iy / (ny - 1))
            for ix in range(nx):
                x = (w - size) // 2 if nx == 1 else int((w - size) * ix / (nx - 1))
                boxes.append((x, y, size))
    boxes.append((0, 0, 0))  # size=0 は全体フレームの意味
    return boxes


# ---------- FastAPI ----------

app = FastAPI(title="FindMy Home Agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def check_key(request: Request):
    if API_KEY and request.headers.get("x-api-key", "") != API_KEY:
        raise HTTPException(401, "APIキーが正しくありません")


class ItemIn(BaseModel):
    name: str
    icon: str = "📦"
    embeddings: list  # list[list[float]]
    thumb: str        # dataURL


class ScanIn(BaseModel):
    threshold: float = 0.7


@app.get("/health")
async def health(_=Depends(check_key)):
    return {
        "ok": True,
        "camera_index": CAMERA_INDEX,
        "items": len(load_items()),
        "auth": bool(API_KEY),
    }


@app.get("/snapshot")
async def snapshot(_=Depends(check_key)):
    frame = camera.read()
    return Response(content=to_jpeg(frame), media_type="image/jpeg")


@app.post("/embed_center")
async def embed_center(_=Depends(check_key)):
    """中央ガイド枠を撮影して埋め込みとサムネイルを返す（登録用）"""
    frame = camera.read()
    h, w = frame.shape[:2]
    x, y, size = center_guide_rect(w, h)
    crop = cv2.resize(frame[y:y + size, x:x + size], (CROP, CROP))
    emb = embed_batch([crop])[0]
    thumb = cv2.resize(crop, (96, 96))
    return {
        "embedding": [round(float(v), 4) for v in emb],
        "thumb": to_data_url(thumb, quality=70),
    }


@app.get("/items")
async def get_items(_=Depends(check_key)):
    with _items_lock:
        items = load_items()
    return [{"id": it["id"], "name": it["name"], "icon": it["icon"],
             "thumb": it["thumb"], "shots": len(it["embeddings"])}
            for it in items]


@app.post("/items")
async def add_item(item: ItemIn, _=Depends(check_key)):
    if not item.name.strip():
        raise HTTPException(400, "アイテム名が空です")
    if len(item.embeddings) < 3:
        raise HTTPException(400, "登録には3枚以上の撮影が必要です")
    with _items_lock:
        items = load_items()
        new = {
            "id": uuid.uuid4().hex[:8],
            "name": item.name.strip(),
            "icon": item.icon,
            "embeddings": item.embeddings,
            "thumb": item.thumb,
        }
        items.append(new)
        save_items(items)
    return {"id": new["id"]}


@app.delete("/items/{item_id}")
async def delete_item(item_id: str, _=Depends(check_key)):
    with _items_lock:
        items = load_items()
        remaining = [it for it in items if it["id"] != item_id]
        if len(remaining) == len(items):
            raise HTTPException(404, "アイテムが見つかりません")
        save_items(remaining)
    return {"ok": True}


@app.post("/scan")
async def scan(body: ScanIn = ScanIn(), _=Depends(check_key)):
    """カメラ画像を走査して登録アイテムを探す"""
    t0 = time.time()
    with _items_lock:
        items = load_items()
    if not items:
        raise HTTPException(400, "アイテムが登録されていません")

    frame = camera.read()
    h, w = frame.shape[:2]
    boxes = gen_scan_boxes(w, h)
    crops = []
    for (x, y, size) in boxes:
        if size == 0:
            crops.append(cv2.resize(frame, (CROP, CROP)))
        else:
            crops.append(cv2.resize(frame[y:y + size, x:x + size], (CROP, CROP)))
    crop_embs = embed_batch(crops)  # [N, D]

    results = []
    annotated = frame.copy()
    for it in items:
        refs = np.array(it["embeddings"], dtype=np.float32)  # [M, D]
        refs /= np.linalg.norm(refs, axis=1, keepdims=True) + 1e-9
        sims = crop_embs @ refs.T  # [N, M]
        best_idx = int(np.unravel_index(np.argmax(sims), sims.shape)[0])
        best_score = float(sims.max())
        found = best_score >= body.threshold
        bx, by, bsize = boxes[best_idx]
        if bsize == 0:
            bx, by, bw_, bh_ = 0, 0, w, h
        else:
            bw_ = bh_ = bsize
        if found:
            cv2.rectangle(annotated, (bx, by), (bx + bw_, by + bh_),
                          (80, 220, 100), max(3, w // 300))
            # 日本語はHersheyフォントで描けないため画像内は%のみ。名前はWeb側でオーバーレイ表示
            cv2.putText(annotated, f"{best_score * 100:.0f}%",
                        (bx + 6, max(24, by - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 220, 100), 2)
        results.append({
            "id": it["id"],
            "name": it["name"],
            "icon": it["icon"],
            "found": found,
            "score": round(best_score, 3),
            "box": {"x": bx / w, "y": by / h, "w": bw_ / w, "h": bh_ / h},
        })

    return {
        "results": sorted(results, key=lambda r: -r["score"]),
        "image": to_data_url(annotated),
        "elapsed_ms": int((time.time() - t0) * 1000),
    }
