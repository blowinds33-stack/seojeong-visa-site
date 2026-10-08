// 날짜·금액·이름 처리. OCR 결과는 띄어쓰기와 기호가 흔들리므로 느슨하게 읽는다.
// (Python 시제품 app/textutil.py 이식)

// ── 날짜 ──────────────────────────────────────────────────────────────
const DATE_PATTERNS = [
  [/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g, "ymd"],
  [/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, "ymd"],
  [/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(20\d{2})/g, "dmy"],
  [/(?<!\d)(2\d)\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?!\d)/g, "yy"],
];

export function mkDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return iso(dt);
}

export const iso = (dt) => dt.toISOString().slice(0, 10);

/** 본문의 날짜 목록 [{date:'YYYY-MM-DD', index}]. 달력에 없는 날짜(93일 등)는 버린다. */
export function findDates(text) {
  const found = new Map();
  for (const [pat, kind] of DATE_PATTERNS) {
    for (const m of text.matchAll(pat)) {
      const [a, b, c] = m.slice(1, 4).map(Number);
      const d = kind === "ymd" ? mkDate(a, b, c) : kind === "dmy" ? mkDate(c, b, a) : mkDate(2000 + a, b, c);
      if (d && !found.has(m.index)) found.set(m.index, d);
    }
  }
  return [...found.entries()].sort((x, y) => x[0] - y[0]).map(([index, date]) => ({ date, index }));
}

/** 발급일 + 1개월 − 1일 (요구사항 v2, 완납증명서 유효기간 표기 방식). */
export function addMonthMinusDay(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const dt = new Date(Date.UTC(ny, nm - 1, Math.min(d, last)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return iso(dt);
}

export const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);

// ── 금액 ──────────────────────────────────────────────────────────────
const WON = /(?<![\d-])(\d{1,3}(?:\s?[,.]\s?\d{3}){2,})(?![\d-])/g;

/** 1,000,000 이상 쉼표 금액. '10, 052,392'처럼 쉼표 주변 공백도 허용. */
export function findWon(text) {
  return [...text.matchAll(WON)].map((m) => Number(m[1].replace(/\D/g, ""))).filter((v) => v > 0);
}

const KDIGIT = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const KSMALL = { 십: 10, 백: 100, 천: 1000 };
const KBIG = { 만: 10000, 억: 100000000 };

export function parseKoreanNumber(s) {
  s = s.replace(/\s/g, "");
  if (!s || [...s].some((ch) => !(ch in KDIGIT || ch in KSMALL || ch in KBIG))) return null;
  let total = 0, section = 0, digit = 0;
  for (const ch of s) {
    if (ch in KDIGIT) digit = KDIGIT[ch];
    else if (ch in KSMALL) { section += (digit || 1) * KSMALL[ch]; digit = 0; }
    else { section += digit; total += (section || 1) * KBIG[ch]; section = 0; digit = 0; }
  }
  return total + section + digit;
}

/** '금일천삼십만삼천삼백삼십팔원정' 같은 한글 금액. */
export function findKoreanAmounts(text) {
  const out = [];
  for (const m of text.matchAll(/금?\s*([일이삼사오육륙칠팔구십백천만억\s]{2,})\s*원/g)) {
    const v = parseKoreanNumber(m[1]);
    if (v && v >= 100000) out.push(v);
  }
  return out;
}

// ── 이름 ──────────────────────────────────────────────────────────────
export const alpha = (s) => s.toUpperCase().replace(/[^A-Z]/g, "");
export const nameTokens = (name) => name.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2);

function longestMatch(a, b, alo, ahi, blo, bhi) {
  let best = [alo, blo, 0];
  let prev = new Map();
  for (let i = alo; i < ahi; i++) {
    const cur = new Map();
    for (let j = blo; j < bhi; j++) {
      if (a[i] === b[j]) {
        const k = (prev.get(j - 1) || 0) + 1;
        cur.set(j, k);
        if (k > best[2]) best = [i - k + 1, j - k + 1, k];
      }
    }
    prev = cur;
  }
  return best;
}

function matchingTotal(a, b, alo, ahi, blo, bhi) {
  if (alo >= ahi || blo >= bhi) return 0;
  const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi);
  if (!k) return 0;
  return k + matchingTotal(a, b, alo, i, blo, j) + matchingTotal(a, b, i + k, ahi, j + k, bhi);
}

/** difflib.SequenceMatcher.ratio()와 같은 계산(Ratcliff/Obershelp). */
export function ratio(a, b) {
  const t = a.length + b.length;
  return t ? (2 * matchingTotal(a, b, 0, a.length, 0, b.length)) / t : 1;
}

/** 명단 성명 단어마다 OCR 글자에서 가장 비슷한 구간을 찾아 평균(0~1). */
export function nameSimilarity(name, text) {
  const toks = nameTokens(name);
  const hay = alpha(text);
  if (!toks.length || !hay) return 0;
  let total = 0, weight = 0;
  for (const tok of toks) {
    const n = tok.length;
    let best = 0;
    if (hay.includes(tok)) best = 1;
    else for (let i = 0; i < Math.max(1, hay.length - n + 1); i++) best = Math.max(best, ratio(tok, hay.slice(i, i + n)));
    const w = n <= 3 ? 0.5 : 1;
    total += best * w; weight += w;
  }
  let score = total / weight;
  // 은행 양식처럼 붙여 쓰다 잘린 이름: 이어진 12자 이상이 그대로 겹치면 같은 사람
  const full = alpha(name);
  const [, , k] = longestMatch(full, hay, 0, full.length, 0, hay.length);
  if (k >= Math.min(12, full.length)) score = Math.max(score, 0.9);
  return score;
}

/** 이름 단어 중 하나라도 비슷하게 들어 있는 정도(서명란의 이름이 누구인지 볼 때). */
export function bestTokenSimilarity(name, text, minLen = 5) {
  const hay = alpha(text);
  let best = 0;
  for (const tok of nameTokens(name).filter((t) => t.length >= minLen)) {
    const n = tok.length;
    for (const size of [n - 2, n - 1, n])
      for (let i = 0; i < Math.max(1, hay.length - size + 1); i++) best = Math.max(best, ratio(tok, hay.slice(i, i + size)));
  }
  return best;
}

export const compact = (s) => s.replace(/\s/g, "").toUpperCase();
