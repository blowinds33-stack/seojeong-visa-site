// 브라우저 PaddleOCR (요구사항 v12). ONNX Runtime Web(wasm)으로 PP-OCRv5 모바일 글자찾기 +
// 한국어 인식 모델을 돌린다. 웹 워커와 메인 화면 어디서나 동작한다(OffscreenCanvas 사용).
import * as ort from "../../vendor/ort/ort.wasm.min.mjs";

const BASE = new URL("../../", import.meta.url);
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MAX_SIDE = 1600; // 글자 찾기 입력 긴 변. 샘플 20쪽에서 2400과 정확도 같고 2배 이상 빠름
const DET_THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.5, REC_MIN_SCORE = 0.5;
export const ENGINE_NAME = "paddleocr-v5-mobile-onnx";

let det = null, rec = null, chars = null;

export async function loadModels(onProgress = () => {}) {
  if (det) return;
  ort.env.wasm.wasmPaths = new URL("vendor/ort/", BASE).href;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const fetchCached = async (path) => {
    // 첫 접속 때 한 번 내려받고 브라우저 캐시에 둔다
    const url = new URL(path, BASE).href;
    let cache = null;
    try { cache = await caches.open("visa-ocr-models-v1"); } catch { /* 캐시 불가 환경 */ }
    let res = cache && (await cache.match(url));
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`모델을 내려받지 못했습니다: ${path}`);
      if (cache) await cache.put(url, res.clone());
    }
    return res;
  };
  onProgress("글자 사전 준비");
  chars = [...(await (await fetchCached("models/korean_dict.json")).json()), " "];
  onProgress("글자 찾기 모델 준비(4.8MB)");
  det = await ort.InferenceSession.create(new Uint8Array(await (await fetchCached("models/PP-OCRv5_mobile_det.onnx")).arrayBuffer()));
  onProgress("한국어 인식 모델 준비(13MB)");
  rec = await ort.InferenceSession.create(new Uint8Array(await (await fetchCached("models/korean_PP-OCRv5_mobile_rec.onnx")).arrayBuffer()));
}

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  return [c, ctx];
}

/** RGBA 픽셀 → 모델 입력(BGR, CHW). */
function toTensor(data, w, h, norm) { // 글자 찾기 입력용
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    const bgr = [data[i + 2], data[i + 1], data[i]];
    for (let c = 0; c < 3; c++) out[c * plane + p] = norm(bgr[c] / 255, c);
  }
  return new ort.Tensor("float32", out, [1, 3, h, w]);
}

async function detect(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const nw = Math.max(32, Math.round((w * s) / 32) * 32), nh = Math.max(32, Math.round((h * s) / 32) * 32);
  const [, ctx] = canvas(nw, nh);
  ctx.drawImage(bitmap, 0, 0, nw, nh);
  const img = ctx.getImageData(0, 0, nw, nh).data;
  const x = toTensor(img, nw, nh, (v, c) => (v - MEAN[c]) / STD[c]);
  const out = await det.run({ [det.inputNames[0]]: x });
  const prob = out[det.outputNames[0]].data; // [1,1,nh,nw]
  // 문턱값 이상인 픽셀의 연결 영역(4방향) → 상자
  const lab = new Int32Array(nw * nh).fill(-1);
  const boxes = [];
  const stack = [];
  for (let p0 = 0; p0 < nw * nh; p0++) {
    if (prob[p0] <= DET_THRESH || lab[p0] !== -1) continue;
    let x0 = nw, y0 = nh, x1 = 0, y1 = 0, area = 0, sum = 0;
    stack.push(p0); lab[p0] = p0;
    while (stack.length) {
      const p = stack.pop();
      const px = p % nw, py = (p - px) / nw;
      area++; sum += prob[p];
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const q of [p - 1, p + 1, p - nw, p + nw]) {
        if (q < 0 || q >= nw * nh || lab[q] !== -1 || prob[q] <= DET_THRESH) continue;
        if ((q === p - 1 && px === 0) || (q === p + 1 && px === nw - 1)) continue;
        lab[q] = p0; stack.push(q);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || sum / area < BOX_THRESH) continue;
    const d = (area * UNCLIP) / (2 * (bw + bh));
    const sx = w / nw, sy = h / nh;
    boxes.push([
      Math.max(0, Math.trunc((x0 - d) * sx)), Math.max(0, Math.trunc((y0 - d) * sy)),
      Math.min(w, Math.trunc((x0 + bw + d) * sx)), Math.min(h, Math.trunc((y0 + bh + d) * sy)),
    ]);
  }
  boxes.sort((a, b) => Math.floor(a[1] / 10) - Math.floor(b[1] / 10) || a[0] - b[0]);
  return boxes;
}

/** 상자 하나를 높이 48로 맞춘 픽셀(RGBA)로 잘라 온다. 세로로 긴 상자는 반시계 90° 돌린다. */
function cropLine(bitmap, box) {
  const [x0, y0, x1, y1] = box;
  const cw = x1 - x0, ch = y1 - y0;
  const vertical = ch > 1.5 * cw;
  const rw = vertical ? ch : cw, rh = vertical ? cw : ch;
  const nw = Math.max(16, Math.min(3200, Math.ceil((48 * rw) / rh)));
  const [, ctx] = canvas(nw, 48);
  if (vertical) {
    ctx.translate(0, 48);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(bitmap, x0, y0, cw, ch, 0, 0, 48, nw);
  } else {
    ctx.drawImage(bitmap, x0, y0, cw, ch, 0, 0, nw, 48);
  }
  return { w: nw, data: ctx.getImageData(0, 0, nw, 48).data };
}

const REC_BATCH = 4;

/** 비슷한 너비끼리 묶어 한 번에 인식한다(남는 칸은 0으로 채움, PaddleOCR과 같은 방식). */
async function recognizeAll(bitmap, boxes, onLine) {
  const crops = boxes.map((b) => (b[2] - b[0] < 2 || b[3] - b[1] < 2 ? null : cropLine(bitmap, b)));
  const order = crops.map((c, i) => i).filter((i) => crops[i]).sort((a, b) => crops[a].w - crops[b].w);
  const results = boxes.map(() => ["", 0]);
  let done = 0;
  for (let s = 0; s < order.length; s += REC_BATCH) {
    const idx = order.slice(s, s + REC_BATCH);
    const W = Math.max(...idx.map((i) => crops[i].w));
    const plane = 48 * W;
    const buf = new Float32Array(idx.length * 3 * plane);
    idx.forEach((ci, b) => {
      const { w, data } = crops[ci];
      const off = b * 3 * plane;
      for (let y = 0; y < 48; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, p = y * W + x;
        buf[off + p] = (data[i + 2] / 255 - 0.5) / 0.5; // B
        buf[off + plane + p] = (data[i + 1] / 255 - 0.5) / 0.5; // G
        buf[off + 2 * plane + p] = (data[i] / 255 - 0.5) / 0.5; // R
      }
    });
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", buf, [idx.length, 3, 48, W]) });
    const t = out[rec.outputNames[0]];
    const [, T, C] = t.dims;
    const d = t.data;
    idx.forEach((ci, b) => {
      // 원래 너비에 해당하는 시간축까지만 읽는다(채운 칸에서 글자가 생기지 않게)
      const Tb = Math.min(T, Math.ceil((T * crops[ci].w) / W) + 1);
      let txt = "", sum = 0, n = 0, prev = 0;
      for (let k = 0; k < Tb; k++) {
        const base = (b * T + k) * C;
        let best = 0, bp = -1;
        for (let c = 0; c < C; c++) { const v = d[base + c]; if (v > bp) { bp = v; best = c; } }
        if (best !== 0 && best !== prev) { txt += chars[best - 1] ?? ""; sum += bp; n++; }
        prev = best;
      }
      results[ci] = [txt, n ? sum / n : 0];
    });
    done += idx.length;
    onLine(done, order.length);
  }
  return results;
}

/** 쪽 이미지(ImageBitmap) → {width,height,lines:[{text,box,score}],engine} */
export async function readPage(bitmap, onLine = () => {}) {
  await loadModels();
  const t0 = performance.now();
  const boxes = await detect(bitmap);
  const t1 = performance.now();
  const recs = await recognizeAll(bitmap, boxes, onLine);
  const lines = [];
  recs.forEach(([text, score], i) => {
    if (text.trim() && score > REC_MIN_SCORE) lines.push({ text, box: boxes[i], score });
  });
  const stats = { detMs: Math.round(t1 - t0), recMs: Math.round(performance.now() - t1), boxes: boxes.length };
  return { width: bitmap.width, height: bitmap.height, lines, engine: ENGINE_NAME, stats };
}
