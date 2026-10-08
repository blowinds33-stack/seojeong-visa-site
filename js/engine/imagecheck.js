// 글자가 아닌 판정: 사진, 필기 흔적, 빨간 도장, 컬러 스캔 여부. (Python app/imagecheck.py 이식)
// img = {width, height, data: Uint8ClampedArray(RGBA)}

function clampBox(img, box) {
  let [x0, y0, x1, y1] = box.map(Math.round);
  x0 = Math.max(0, Math.min(x0, x1)); x1 = Math.min(img.width, Math.max(x0, x1));
  y0 = Math.max(0, Math.min(y0, y1)); y1 = Math.min(img.height, Math.max(y0, y1));
  return [x0, y0, x1, y1];
}

/** 진한 검정·파랑 펜 픽셀 마스크(인쇄된 연회색 안내문은 제외). */
function inkMask(img, box, masked = []) {
  const [x0, y0, x1, y1] = clampBox(img, box);
  const w = x1 - x0, h = y1 - y0;
  const m = new Uint8Array(Math.max(0, w * h));
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x0 + x, gy = y0 + y;
      if (masked.some((b) => gx >= b[0] && gx < b[2] && gy >= b[1] && gy < b[3])) continue;
      const i = (gy * img.width + gx) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const gray = (r + g + b) / 3;
      if (gray < 110 || (b - r > 45 && b - g > 15 && gray < 190)) m[y * w + x] = 1;
    }
  }
  return { m, w, h };
}

/** 영역 안 필기 비율(마스크 영역은 제외). 표 테두리 같은 긴 직선과 먼지는 뺀다. */
export function inkRatio(img, box, masked = [], removeLines = true) {
  const { m, w, h } = inkMask(img, box, masked);
  if (!w || !h) return 0;
  if (removeLines) {
    const kx = Math.max(15, Math.floor(w / 8)), ky = Math.max(15, Math.floor(h / 2));
    // 가로로 kx 이상 이어진 구간, 세로로 ky 이상 이어진 구간은 선으로 보고 지운다
    const kill = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && m[y * w + x]) run++;
        else { if (run >= kx) for (let k = x - run; k < x; k++) kill[y * w + k] = 1; run = 0; }
      }
    }
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y <= h; y++) {
        if (y < h && m[y * w + x]) run++;
        else { if (run >= ky) for (let k = y - run; k < y; k++) kill[k * w + x] = 1; run = 0; }
      }
    }
    for (let i = 0; i < m.length; i++) if (kill[i]) m[i] = 0;
  }
  // 20픽셀 미만 덩어리(먼지) 제거
  const seen = new Uint8Array(w * h);
  let keep = 0;
  const st = [];
  for (let p0 = 0; p0 < m.length; p0++) {
    if (!m[p0] || seen[p0]) continue;
    let n = 0; st.push(p0); seen[p0] = 1;
    while (st.length) {
      const p = st.pop(); n++;
      const px = p % w;
      for (const q of [p - 1, p + 1, p - w, p + w, p - w - 1, p - w + 1, p + w - 1, p + w + 1]) {
        if (q < 0 || q >= m.length || seen[q] || !m[q]) continue;
        const qx = q % w;
        if (Math.abs(qx - px) > 1) continue;
        seen[q] = 1; st.push(q);
      }
    }
    if (n >= 20) keep += n;
  }
  return keep / (w * h);
}

/** 단순 필기 비율(선·먼지 제거 없이). 신청 구분 체크칸처럼 작은 영역용. */
export function rawInkRatio(img, box) {
  const { m } = inkMask(img, box);
  if (!m.length) return 0;
  let s = 0;
  for (const v of m) s += v;
  return s / m.length;
}

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dlt = mx - mn;
  let hdeg = 0;
  if (dlt) {
    if (mx === r) hdeg = 60 * (((g - b) / dlt) % 6);
    else if (mx === g) hdeg = 60 * ((b - r) / dlt + 2);
    else hdeg = 60 * ((r - g) / dlt + 4);
  }
  if (hdeg < 0) hdeg += 360;
  return [hdeg / 2, mx ? (dlt / mx) * 255 : 0, mx]; // OpenCV 범위(H 0~180, S·V 0~255)
}

/** 빨간 인영(도장) 후보 상자 목록. 가로로 긴 빨간 인쇄 숫자는 제외. */
export function redSeals(img, minFrac = 0.025) {
  const { width: w, height: h, data: d } = img;
  // 계산량을 줄이려 1/2 크기에서 본다
  const sw = Math.floor(w / 2), sh = Math.floor(h / 2);
  const red = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = ((y * 2) * w + x * 2) * 4;
    const [H, S, V] = hsv(d[i], d[i + 1], d[i + 2]);
    if (S >= 70 && V >= 70 && (H <= 12 || H >= 160)) red[y * sw + x] = 1;
  }
  // 닫기 연산(9px@원본 ≈ 4px@절반): 팽창 후 침식
  const dil = morph(red, sw, sh, 2, true);
  const mask = morph(dil, sw, sh, 2, false);
  const seen = new Uint8Array(sw * sh), out = [], st = [];
  const size = (w * minFrac) / 2;
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    let x0 = sw, y0 = sh, x1 = 0, y1 = 0, area = 0;
    st.push(p0); seen[p0] = 1;
    while (st.length) {
      const p = st.pop(), px = p % sw, py = (p - px) / sw;
      area++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const q of [p - 1, p + 1, p - sw, p + sw]) {
        if (q < 0 || q >= mask.length || seen[q] || !mask[q]) continue;
        if (Math.abs((q % sw) - px) > 1) continue;
        seen[q] = 1; st.push(q);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < size || bh < size) continue;
    const aspect = bw / bh, fill = area / (bw * bh);
    if (aspect > 0.4 && aspect < 2.5 && fill > 0.12) out.push([x0 * 2, y0 * 2, (x1 + 1) * 2, (y1 + 1) * 2]);
  }
  return out;
}

function morph(src, w, h, r, dilate) {
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const xx = x + k;
      const s = xx < 0 || xx >= w ? (dilate ? 0 : 1) : src[y * w + xx];
      if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      const s = yy < 0 || yy >= h ? (dilate ? 0 : 1) : tmp[yy * w + x];
      if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

/** 흑백 스캔이면 도장 색을 판별할 수 없다(운영 규칙: 컬러 스캔). */
export function isColorScan(img) {
  const { width: w, height: h, data: d } = img;
  let n = 0, s = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4;
    if (hsv(d[i], d[i + 1], d[i + 2])[1] > 60) s++;
    n++;
  }
  return s / n > 0.0008;
}

/** 통합신청서 오른쪽 위 사진 칸이 채워져 있는지(샘플: 빈 칸 0.00, 사진 0.11~0.22). */
export function photoFill(img) {
  const { width: w, height: h, data: d } = img;
  const X0 = Math.floor(0.70 * w), X1 = Math.floor(0.97 * w), Y0 = Math.floor(0.12 * h), Y1 = Math.floor(0.40 * h);
  const step = 2, cw = Math.floor((X1 - X0) / step), ch = Math.floor((Y1 - Y0) / step);
  const dark = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((Y0 + y * step) * w + X0 + x * step) * 4;
    dark[y * cw + x] = (d[i] + d[i + 1] + d[i + 2]) / 3 < 200 ? 1 : 0;
  }
  // 25px 상자 평균(원본 기준) → 절반 크기에서 13px
  const r = 6;
  const integ = new Float64Array((cw + 1) * (ch + 1));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++)
    integ[(y + 1) * (cw + 1) + x + 1] = dark[y * cw + x] + integ[y * (cw + 1) + x + 1] + integ[(y + 1) * (cw + 1) + x] - integ[y * (cw + 1) + x];
  let dense = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const a = Math.max(0, x - r), b = Math.max(0, y - r), c = Math.min(cw, x + r + 1), e = Math.min(ch, y + r + 1);
    const s = integ[e * (cw + 1) + c] - integ[b * (cw + 1) + c] - integ[e * (cw + 1) + a] + integ[b * (cw + 1) + a];
    if (s / ((c - a) * (e - b)) > 0.5) dense++;
  }
  return dense / (cw * ch);
}
