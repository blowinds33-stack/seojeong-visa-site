// 서류별 판정 규칙. 요구사항정의서 v4 종합표와 v6~v11 변경을 따른다(Python app/rules.py 이식).
// 원칙(v9): 값을 확신할 수 없으면 통과로 처리하지 않고 '확인 필요'로 넘긴다.
import * as ic from "./imagecheck.js";
import { DOC_TYPES } from "./classify.js";
import {
  addMonthMinusDay, alpha, bestTokenSimilarity, compact, daysBetween, findDates, findKoreanAmounts,
  findWon, nameSimilarity,
} from "./textutil.js";

export const PASS = "pass", WARN = "warn", CHECK = "check", FAIL = "fail", MISSING = "missing", INFO = "info";
export const VERDICT_LABEL = { pass: "통과", warn: "주의", check: "확인 필요", fail: "불가", missing: "누락", info: "참고" };
export const SEVERITY = { info: 0, pass: 1, warn: 2, check: 3, missing: 4, fail: 5 };
const MIN_BALANCE = 10_000_000;
const WARN_DAYS = 7;
const SIG_INK = 0.012; // 서명·기재 판정 필기 비율 기준(샘플 8장: 빈 칸 0.5% 이하, 서명 2.8% 이상)

export const SCENARIOS = {
  dorm: "① 서정대 기숙사",
  own: "② 본인 명의 월세",
  own_goshiwon: "③ 본인 명의 고시원",
  friend: "④ 친구 집 — 친구 명의 계약",
  friend_joint: "④-1 친구 집 — 공동명의 계약",
  friend_goshiwon: "⑤ 친구 집 — 고시원",
};

const won = (n) => n.toLocaleString("ko-KR");
const pct = (x) => `${Math.round(x * 100)}%`;
const cy = (l) => (l.box[1] + l.box[3]) / 2;
const cx = (l) => (l.box[0] + l.box[2]) / 2;
const text = (pg) => pg.lines.map((l) => l.text).join("\n");

class Result {
  constructor() {
    this.items = []; this.checklist = []; this.scenario = null; this.scenarioReason = "";
    this.balanceExpiry = null; this.rescanPages = []; this.leaseKey = "";
  }
  add(doc, label, value, verdict, reason = "", pageId = null) {
    this.items.push({ doc, label, value, verdict, reason, pageId });
  }
  get overall() {
    const sev = this.items.filter((i) => i.verdict !== INFO).map((i) => SEVERITY[i.verdict]);
    for (const c of this.checklist) if (!c.ok) sev.push(SEVERITY.missing);
    if (!sev.length) return INFO;
    const top = Math.max(...sev);
    return Object.keys(SEVERITY).find((k) => SEVERITY[k] === top);
  }
  counts() {
    const out = { pass: 0, warn: 0, check: 0, fail: 0, missing: 0 };
    for (const i of this.items) if (i.verdict in out) out[i.verdict]++;
    out.missing += this.checklist.filter((c) => !c.ok).length;
    return out;
  }
  toJSON() {
    return {
      items: this.items, checklist: this.checklist, scenario: this.scenario, scenarioReason: this.scenarioReason,
      balanceExpiry: this.balanceExpiry, rescanPages: this.rescanPages, leaseKey: this.leaseKey,
      overall: this.overall, counts: this.counts(),
    };
  }
}

// ── 공통 도우미 ─────────────────────────────────────────────────────────
export function findLines(pg, pattern) {
  const rx = new RegExp(pattern, "i");
  return pg.lines.filter((l) => rx.test(compact(l.text)));
}

export function rowText(pg, ref, xMin = 0, tol = 0.8) {
  const h = ref.box[3] - ref.box[1];
  return pg.lines
    .filter((l) => Math.abs(cy(l) - cy(ref)) < h * tol && l.box[0] >= xMin)
    .sort((a, b) => a.box[0] - b.box[0])
    .map((l) => l.text).join(" ");
}

function maskedInk(img, box, pg, labelRx) {
  const rx = new RegExp(`^(?:${labelRx})$`, "i");
  const masked = pg.lines.filter((l) => rx.test(compact(l.text))).map((l) => l.box);
  return ic.inkRatio(img, box, masked, true);
}

function rescanNeeded(pg) {
  if (pg.lines.length < 8) return true;
  return pg.lines.reduce((s, l) => s + l.score, 0) / pg.lines.length < 0.8;
}

/** 명단이 없을 때 인쇄 서류(잔액증명서 예금주·건강보험 가입자)에서 영문 성명 추정. */
export function guessName(pages) {
  for (const p of pages) {
    if (!["balance", "health"].includes(p.kind)) continue;
    for (const l of findLines(p.ocr, "예금주|DEPOSITER|DEPOSITOR|가입자성명")) {
      const t = rowText(p.ocr, l, l.box[0]).toUpperCase();
      const m = (t.match(/[A-Z][A-Z ]{3,}[A-Z]/g) || []).filter((x) => !/DEPOSIT|TRUST|TRUSTER|REGISTRATION/.test(x));
      if (m.length) return m.reduce((a, b) => (b.length > a.length ? b : a)).trim();
    }
  }
  return "";
}

// ── 통합신청서 ──────────────────────────────────────────────────────────
const APP_OPTIONS = ["외국인등록", "등록증재발급", "체류기간연장", "체류자격변경", "체류자격부여",
  "체류자격외활동", "근무처변경", "재입국허가", "체류지변경", "등록사항변경"];
const SIG_LABEL = "(신청인)?(서명또는인|서명또는|SIGNATURE/?SEAL|SIGNATURE|SEAL|SIGNATURE/SEAL)+";

function checkApplication(p, img, name, r) {
  const doc = DOC_TYPES.application;
  const pg = p.ocr, W = pg.width, H = pg.height;
  const fill = ic.photoFill(img);
  const photo = fill > 0.05;
  r.add(doc, "사진", photo ? "있음" : "없음", photo ? PASS : FAIL, photo ? "" : "사진 칸이 비어 있음", p.id);

  // 서명 ① 신청일 옆
  const dateLbl = findLines(pg, "DATEOFAPPLICATION|신청일");
  if (dateLbl.length) {
    const l = dateLbl[dateLbl.length - 1];
    const ink = maskedInk(img, [W * 0.66, cy(l) - H * 0.009, W * 0.98, cy(l) + H * 0.009], pg, SIG_LABEL);
    const ok = ink > SIG_INK;
    r.add(doc, "서명(신청일 옆)", ok ? "있음" : "없음", ok ? PASS : FAIL, ok ? "" : "신청인 서명칸이 비어 있음", p.id);
    // 신청일 기재 여부: 라벨 오른쪽부터 '신청인 서명' 라벨 앞까지, 위아래 줄이 섞이지 않게 좁은 띠
    const sigLbl = findLines(pg, "신청인서명|서명또는인").filter((s) => Math.abs(cy(s) - cy(l)) < H * 0.015 && s.box[0] > l.box[2]);
    // OCR이 손글씨 날짜를 서명 라벨과 한 줄로 붙여 읽으면(예: '026-0+-26신청인 서명') 그 줄은 경계로 쓰지 않고 기재로 본다
    const clean = sigLbl.filter((s) => /^(신청인|서명)/.test(compact(s.text)));
    const mergedDate = sigLbl.some((s) => /\d/.test(compact(s.text).split(/신청인서명|서명또는인/)[0]));
    const xEnd = Math.min(W * 0.49, ...clean.map((s) => s.box[0])) - 4;
    const inkD = maskedInk(img, [l.box[2] + 4, cy(l) - H * 0.009, xEnd, cy(l) + H * 0.009], pg, "DATEOFAPPLICATION|신청일");
    const filled = inkD > 0.008 || mergedDate || findDates(rowText(pg, l)).length > 0;
    r.add(doc, "신청일", filled ? "기재" : "빈칸", filled ? PASS : WARN, filled ? "" : "신청일이 비어 있음", p.id);
  } else {
    r.add(doc, "서명(신청일 옆)", "칸을 찾지 못함", CHECK, "원본에서 직접 확인", p.id);
  }

  // 서명 ② 행정정보 공동이용 동의서
  const consent = findLines(pg, "행정정보공동이용|CONSENTFORSHARING");
  if (!consent.length) {
    r.add(doc, "서명(공동이용 동의)", "칸 없음", FAIL, "행정정보 공동이용 동의서 서명란이 없는 양식(서명 2곳 필수)", p.id);
  } else {
    const c0 = cy(consent[0]);
    let appLbl = findLines(pg, "APPLICANT$|^신청인APPLICANT|^신청인$").filter((l) => cy(l) > c0);
    // OCR이 서명을 라벨과 한 줄로 붙여 읽은 경우(예: '신청인NGUYTH서신청인의배우자')
    const merged = !appLbl.length;
    if (merged) appLbl = findLines(pg, "^신청인").filter((l) => cy(l) > c0 && l.box[0] < W * 0.2);
    if (appLbl.length) {
      const a = appLbl[0];
      const near = findLines(pg, "배우자|SPOUSE")
        .filter((s) => s !== a && cy(s) > c0 && Math.abs(cy(s) - cy(a)) < H * 0.03).map((s) => s.box[0]);
      const x1 = near.length ? Math.min(...near) : W * (merged ? 0.35 : 0.45);
      // 붙어 읽힌 줄은 가릴 수 없으므로 인쇄 라벨('신청인 Applicant') 오른쪽부터 본다
      const x0 = merged ? W * 0.16 : W * 0.08;
      const ink = maskedInk(img, [x0, cy(a) - H * 0.012, x1 - 4, cy(a) + H * 0.012], pg, `(신청인)?APPLICANT|${SIG_LABEL}`);
      const readName = merged && /[A-Z]{3,}/.test(compact(a.text).replace(/^신청인/, "").split("신청인")[0]);
      const ok = ink > SIG_INK || readName;
      r.add(doc, "서명(공동이용 동의)", ok ? "있음" : "없음", ok ? PASS : FAIL, ok ? "" : "동의서 신청인 서명칸이 비어 있음", p.id);
    } else {
      r.add(doc, "서명(공동이용 동의)", "칸을 찾지 못함", CHECK, "원본에서 직접 확인", p.id);
    }
  }

  // 신청 구분: 표시만(판정 제외, v10)
  const opts = [];
  for (const l of pg.lines) {
    const t = compact(l.text);
    const hit = APP_OPTIONS.find((o) => t.includes(o));
    if (hit && cy(l) < H * 0.4 && l.box[0] < W * 0.7) {
      const marked = /^\)?\[?[√✓✔VX/'`]\]/.test(t);
      const x = /^(\[|\)\[|\]|1)/.test(t) ? l.box[0] : l.box[0] - W * 0.03;
      const ink = ic.rawInkRatio(img, [x, cy(l) - H * 0.009, x + W * 0.028, cy(l) + H * 0.009]);
      opts.push([hit, marked, ink]);
    }
  }
  if (opts.length) {
    let shown = opts.filter((o) => o[1]).map((o) => o[0]);
    let how = "체크 판독";
    if (!shown.length && opts.length >= 3) {
      const ranked = [...opts].sort((a, b) => b[2] - a[2]);
      if (ranked[0][2] > 0.04 && ranked[0][2] > ranked[1][2] * 1.5) { shown = [ranked[0][0]]; how = "필기량으로 추정"; }
    }
    if (shown.length) r.add(doc, "신청 구분", shown.join(", "), INFO, how, p.id);
  }

  if (name) {
    const sim = nameSimilarity(name, text(pg));
    const v = sim >= 0.8 ? PASS : CHECK;
    r.add(doc, "성명", `명단 성명과 유사도 ${pct(sim)}`, v, v === PASS ? "" : "손글씨 성명이 명단과 다르거나 판독 어려움", p.id);
  }

  for (const [lbl, rx] of [["여권번호", "PASSPORTNO"], ["외국인등록번호", "REGISTRATIONNO|외국인등록번호"], ["대한민국 내 주소", "ADDRESSINKOREA|대한민국내주소"]]) {
    const hits = findLines(pg, rx);
    if (hits.length) r.add(doc, lbl, rowText(pg, hits[0], hits[0].box[2] - 5).slice(0, 60) || "-", INFO, "판독값 표시만", p.id);
  }
}

// ── 잔액증명서 ──────────────────────────────────────────────────────────
function dateNear(pg, labelRx) {
  for (const l of findLines(pg, labelRx)) {
    const ds = findDates(rowText(pg, l, l.box[0] - 5));
    if (ds.length) return ds[0].date;
  }
  return null;
}

function checkBalance(p, img, name, received, r, nPages) {
  const doc = DOC_TYPES.balance;
  const pg = p.ocr, t = text(pg);
  const nums = findWon(t), kor = findKoreanAmounts(t);
  let total = nums.length ? Math.max(...nums) : null;
  if (total === null && kor.length) total = Math.max(...kor);
  if (total === null) {
    r.add(doc, "잔액", "읽지 못함", CHECK, "금액을 찾지 못함 — 원본 확인", p.id);
  } else {
    const confirmed = kor.includes(total) || nums.filter((n) => n === total).length >= 2;
    const nearLine = Math.abs(total - MIN_BALANCE) < MIN_BALANCE * 0.02;
    let v, why;
    if (kor.length && !kor.includes(total)) [v, why] = [CHECK, `숫자 금액과 한글 금액(${won(Math.max(...kor))}원)이 다름 — 원본 확인`];
    else if (!confirmed && nearLine) [v, why] = [CHECK, "1천만 원 근처 금액을 한 곳에서만 읽음 — 원본 확인"];
    else if (total < MIN_BALANCE) [v, why] = [FAIL, "1천만 원 미만"];
    else [v, why] = [PASS, ""];
    r.add(doc, "잔액", `${won(total)}원`, v, why, p.id);
  }

  for (const l of findLines(pg, "지급정지|기타제한금액|질권")) {
    const amt = findWon(rowText(pg, l));
    if (amt.length) { r.add(doc, "지급정지·제한", `${won(Math.max(...amt))}원`, INFO, "출입국 판단 사항(참고)", p.id); break; }
  }

  let issued = dateNear(pg, "발급일|DATEOFISSUE|ISSUINGDATE|발급일자");
  if (!issued) {
    const ds = findDates(t).map((d) => d.date).filter((d) => !received || d <= received).sort();
    issued = ds.length ? ds[ds.length - 1] : null;
  }
  if (!issued) {
    r.add(doc, "발급일", "읽지 못함", CHECK, "발급일을 찾지 못함 — 원본 확인", p.id);
  } else {
    const exp = addMonthMinusDay(issued);
    r.balanceExpiry = !r.balanceExpiry || exp > r.balanceExpiry ? exp : r.balanceExpiry;
    if (!received) {
      r.add(doc, "유효기간", `발급 ${issued} → ${exp}까지`, CHECK, "접수일이 없어 판정 불가", p.id);
    } else {
      const left = daysBetween(received, exp);
      let v = PASS, why = "";
      if (left < 0) [v, why] = [FAIL, `접수일(${received}) 기준 유효기간 ${-left}일 경과`];
      else if (left <= WARN_DAYS) [v, why] = [WARN, `유효기간 ${left}일 남음 — 출입국 방문 일정 먼저`];
      r.add(doc, "유효기간", left >= 0 ? `발급 ${issued} → ${exp}까지 (D-${left})` : `발급 ${issued} → ${exp}까지`, v, why, p.id);
    }
  }

  if (name) {
    const dep = findLines(pg, "예금주|DEPOSIT");
    const depText = dep.map((l) => rowText(pg, l)).join(" ") || t;
    const sim = nameSimilarity(name, depText);
    r.add(doc, "예금주", `신청인 성명과 유사도 ${pct(sim)}`, sim >= 0.8 ? PASS : CHECK, sim >= 0.8 ? "" : "예금주가 신청인과 다르거나 판독 어려움", p.id);
  }

  // 도장·서명란(v8 1.1): 도장 0개만 불가, 애매하면 확인 필요
  const seals = ic.redSeals(img);
  const hasSigField = findLines(pg, "책임자|AUTHORIZED|발급자|취급자|서명\\(|SIGNATURE").length > 0;
  if (!ic.isColorScan(img)) r.add(doc, "도장", "흑백 스캔", CHECK, "흑백 스캔이라 도장을 판별할 수 없음 — 컬러로 재스캔", p.id);
  else if (!seals.length) r.add(doc, "도장", "0개", FAIL, "도장이 보이지 않음", p.id);
  else if (hasSigField && seals.length >= 2) r.add(doc, "도장·서명란", `도장 ${seals.length}개, 서명란 있음`, PASS, "", p.id);
  else {
    const why = hasSigField ? "도장 2개 미만" : "서명란 없는 양식";
    r.add(doc, "도장·서명란", `도장 ${seals.length}개`, CHECK, `${why}, 도장 ${seals.length}개 검출 — 원본 확인`, p.id);
  }

  for (const l of pg.lines) {
    if (cy(l) >= pg.height * 0.12) continue;
    const m = l.text.match(/^\s*(\d)\s*\/\s*(\d)\s*$/);
    if (m && Number(m[2]) > nPages) {
      r.add(doc, "쪽 수", `${m[1]}/${m[2]}쪽 표기, 받은 쪽 ${nPages}`, MISSING, "잔액증명서 일부 쪽 누락", p.id);
      break;
    }
  }
}

// ── 건강보험 ────────────────────────────────────────────────────────────
function healthKind(pg) {
  const t = compact(text(pg));
  if (t.includes("완납증명서")) return "완납증명서";
  if (t.includes("정산내역")) return "월별 정산내역";
  return "납부확인서";
}

function parseMonthTable(pg) {
  const gox = findLines(pg, "^고지금액"), nab = findLines(pg, "^납부금액");
  let mid;
  if (gox.length && nab.length) mid = (cx(gox[0]) + cx(nab[0])) / 2;
  else if (nab.length) mid = cx(nab[0]) - pg.width * 0.18; // 공단 양식: 두 제목 간격은 쪽 너비의 약 36%
  else if (gox.length) mid = cx(gox[0]) + pg.width * 0.18;
  else return null;
  const rows = [];
  for (const l of pg.lines) {
    const m = compact(l.text).match(/^(\d{1,2})월$/);
    if (!m) continue;
    const hgt = l.box[3] - l.box[1];
    const cells = pg.lines.filter((c) => c !== l && Math.abs(cy(c) - cy(l)) < hgt * 0.7 && c.box[0] > l.box[2]);
    const left = [], right = [];
    for (const c of cells) {
      for (const tok of c.text.replaceAll("O", "0").match(/\d{1,3}(?:\s?[,.]\s?\d{3})+|\d+/g) || []) {
        const v = Number(tok.replace(/\D/g, ""));
        if (v >= 100) (cx(c) < mid ? left : right).push(v); // 0과 워터마크 잡음은 버린다
      }
    }
    rows.push([Number(m[1]), left, right]);
  }
  return rows.length ? rows : null;
}

function checkHealth(pages, name, received, r, birth) {
  const doc = DOC_TYPES.health;
  for (const p of pages) {
    const pg = p.ocr, kind = healthKind(pg);
    if (kind === "월별 정산내역") { r.add(doc, `${p.no}쪽`, kind, INFO, "보조 서류", p.id); continue; }
    if (compact(text(pg)).includes("열람용")) r.add(doc, `${p.no}쪽 열람용`, "열람용 출력본", INFO, "열람용도 인정(v3)", p.id);
    if (kind === "완납증명서") {
      const exp = dateNear(pg, "유효기간");
      if (!exp) r.add(doc, "완납증명서 유효기간", "읽지 못함", CHECK, "원본 확인", p.id);
      else if (received) {
        const left = daysBetween(received, exp);
        const v = left < 0 ? FAIL : left <= WARN_DAYS ? WARN : PASS;
        r.add(doc, "완납증명서 유효기간", `${exp}까지`, v, { fail: "유효기간 경과", warn: `유효기간 ${left}일 남음`, pass: "" }[v], p.id);
      } else r.add(doc, "완납증명서 유효기간", `${exp}까지`, CHECK, "접수일 없음", p.id);
    } else {
      const rows = parseMonthTable(pg);
      const lbl = `납부확인서(${p.no}쪽)`;
      if (!rows) r.add(doc, lbl, "표를 읽지 못함", CHECK, "고지·납부 금액 원본 확인", p.id);
      else {
        // 미납: 고지액은 있는데 납부액 0. 둘 다 있는데 다르면 판독 문제일 수 있어 확인 필요
        const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        const unpaid = rows.filter(([, a, b]) => a.length && !b.length).map((x) => x[0]);
        const differ = rows.filter(([, a, b]) => a.length && b.length && !same(a, b)).map((x) => x[0]);
        if (unpaid.length) r.add(doc, lbl, `${unpaid.join(", ")}월 미납`, FAIL, "고지액이 있는데 납부액이 0", p.id);
        else if (differ.length) r.add(doc, lbl, `${differ.join(", ")}월 금액 판독 불일치`, CHECK, "고지·납부 금액 원본 확인", p.id);
        else r.add(doc, lbl, "고지액 = 납부액", PASS, "", p.id);
      }
    }
    if (birth && findDates(text(pg)).some((d) => d.date === birth)) continue; // 생년월일이 같으면 같은 사람(v1)
    if (name) {
      const sim = nameSimilarity(name, text(pg));
      if (sim < 0.8) r.add(doc, `가입자(${p.no}쪽)`, `유사도 ${pct(sim)}`, CHECK, "가입자 성명이 다르거나 한글 약칭 — 생년월일로 확인", p.id);
    }
  }
}

// ── 체류지 ──────────────────────────────────────────────────────────────
function leaseRole(pages, name) {
  let best = 0, bestLine = null, bestPg = null;
  for (const p of pages) {
    for (const l of p.ocr.lines) {
      if (alpha(l.text).length < 4) continue;
      const h = l.box[3] - l.box[1];
      const below = p.ocr.lines.filter((b) => cy(b) - cy(l) > 0 && cy(b) - cy(l) < h * 2.2 && Math.abs(b.box[0] - l.box[0]) < h * 2);
      const s = nameSimilarity(name, `${rowText(p.ocr, l, l.box[0] - 5)} ${below.map((b) => b.text).join(" ")}`);
      if (s > best) { best = s; bestLine = l; bestPg = p; }
    }
  }
  const joint = pages.flatMap((p) => findLines(p.ocr, "공동명의|공동임차").map((l) => [p, l]));
  if (best < 0.6) return ["absent", "계약서에 신청인 이름이 없음"];
  if (best < 0.8) return ["unsure", `계약서의 신청인 이름 판독이 불확실(유사도 ${pct(best)})`];
  // 신청인이 공동명의인 칸에 있으면 친구 집, 주 임차인이면 공동명의가 있어도 본인 명의(v11)
  const near = joint.some(([p, l]) => p === bestPg && Math.abs(cy(l) - cy(bestLine)) < p.ocr.height * 0.03);
  if (near) return ["joint", "신청인이 공동명의인"];
  return ["own", joint.length ? "신청인이 주 임차인(공동명의인이 있어도 본인 명의)" : "신청인이 임차인"];
}

// '까지'를 '까자'처럼 잘못 읽는 경우가 있어 비슷한 글자와 '임대차기간·존속기간' 줄도 본다(샘플 F)
const END_HINT = /까[지자치ㅈ]|임대차기간|존속기간|계약기간/;

function leaseEnd(pages) {
  const ends = [];
  for (const p of pages) for (const l of p.ocr.lines) if (END_HINT.test(compact(l.text))) ends.push(...findDates(rowText(p.ocr, l)).map((d) => d.date));
  return ends.length ? ends.sort()[ends.length - 1] : null; // 못 읽으면 추측하지 않는다
}

const leaseDates = (pages) => pages.flatMap((p) => findDates(text(p.ocr)).map((d) => d.date));

async function checkResidence(by, name, received, r, override, getImg) {
  const lease = by.lease || [];
  const goshiwon = lease.some((p) => compact(text(p.ocr)).includes("고시원"));
  let scen, why;
  if (override) [scen, why] = [override, "담당자 지정"];
  else if (by.dorm?.length) [scen, why] = ["dorm", "기숙사 확인서 제출"];
  else if (lease.length) {
    const [role, w] = name ? leaseRole(lease, name) : ["unsure", "명단 성명이 없어 판단 불가"];
    why = w;
    scen = role === "own" ? (goshiwon ? "own_goshiwon" : "own") : role === "joint" ? "friend_joint"
      : role === "absent" ? (goshiwon ? "friend_goshiwon" : "friend") : null;
  } else [scen, why] = [null, "체류지 서류가 없음"];
  r.scenario = scen; r.scenarioReason = why;

  const doc = DOC_TYPES.lease;
  if (lease.length) {
    const end = leaseEnd(lease);
    const ext = lease.some((p) => compact(text(p.ocr)).includes("연장"));
    if (!end) r.add(doc, "계약기간", "읽지 못함", CHECK, "원본 확인", lease[0].id);
    else if (received && end < received) {
      // 만료로 읽혔어도 계약서에 접수일 이후 날짜가 있으면 판독 실수일 수 있다 → 불가 대신 확인 필요
      const later = leaseDates(lease).filter((d) => d >= received).sort().pop();
      if (ext) r.add(doc, "계약기간", `${end}까지`, CHECK, "계약기간 만료 — 연장 기재가 있어 원본 확인", lease[0].id);
      else if (later) r.add(doc, "계약기간", `${end}까지?`, CHECK, `만료로 읽혔으나 계약서에 ${later} 날짜가 있음 — 원본 확인`, lease[0].id);
      else r.add(doc, "계약기간", `${end}까지`, FAIL, "계약기간 만료", lease[0].id);
    }
    else r.add(doc, "계약기간", `${end}까지`, received ? PASS : CHECK, received ? "" : "접수일 없음", lease[0].id);
    const loc = lease.flatMap((p) => findLines(p.ocr, "^소재지|^부동산의표시:"));
    if (loc.length) {
      const p0 = lease[0];
      r.add(doc, "소재지", rowText(p0.ocr, loc[0], loc[0].box[0]).slice(0, 70), INFO, "판독값", p0.id);
      r.leaseKey = rowText(p0.ocr, loc[0]).replace(/[^0-9가-힣]/g, "").slice(0, 40);
    }
    if (scen === null && name) r.add(doc, "신청인 위치", "판단 불가", CHECK, `${why} — 체류지 유형을 직접 선택`, lease[0].id);
    else if (scen) r.add(doc, "체류지 유형", SCENARIOS[scen], INFO, why, lease[0].id);
  }

  // 거주제공 확인서: 제공자 서명이 신청인 본인이면 불가(샘플 D)
  for (const p of by.residence_confirm || []) {
    const doc2 = DOC_TYPES.residence_confirm;
    const nm = findLines(p.ocr, "\\(NAME\\)").filter((l) => cy(l) > p.ocr.height * 0.45);
    if (!nm.length || !name) continue;
    const last = nm[nm.length - 1];
    const own = bestTokenSimilarity(name, rowText(p.ocr, last, last.box[0]));
    if (own >= 0.85) r.add(doc2, "확인란 서명자", "신청인 이름", FAIL, "제공자가 아니라 신청인 본인이 서명", p.id);
    else if (own >= 0.7) r.add(doc2, "확인란 서명자", "신청인 이름과 비슷함", CHECK, "확인란에 신청인 본인이 서명한 것으로 보임 — 제공자 서명인지 원본 확인", p.id);
    else {
      const img = await getImg(p);
      const W = p.ocr.width, H = p.ocr.height;
      const seal = ic.redSeals(img).some((b) => b[1] > H * 0.45);
      const ink = maskedInk(img, [W * 0.4, cy(last) - H * 0.02, W * 0.97, cy(last) + H * 0.02], p.ocr,
        "성명\\(NAME\\):?|\\(서명\\)?\\(?SIGNATURE\\)?|\\(서명|SIGNATUREORSEAL\\)?");
      const ok = seal || ink > SIG_INK;
      r.add(doc2, "제공자 서명·날인", ok ? "있음" : "없음", ok ? PASS : FAIL, ok ? "" : "제공자 서명이 보이지 않음", p.id);
    }
  }

  // 제공자 신분증 주인이 계약서에 있는지
  const ids = by.provider_id || [];
  if (ids.length && lease.length) {
    const leaseText = lease.map((p) => text(p.ocr)).join(" ");
    const leaseK = leaseText.replace(/[^가-힣]/g, "");
    let ok = false;
    for (const p of ids) for (const l of p.ocr.lines) {
      const k = l.text.replace(/[^가-힣]/g, "");
      if (k.length >= 2 && k.length <= 4 && leaseK.includes(k) && !["성명", "주소", "임대인", "임차인"].includes(k)) ok = true;
      if (alpha(l.text).length >= 8 && nameSimilarity(l.text, leaseText) >= 0.85) ok = true;
    }
    r.add(DOC_TYPES.provider_id, "신분증 주인", ok ? "계약서에 있음" : "확인 못함", ok ? PASS : CHECK, ok ? "" : "신분증 주인과 계약서 임차인이 같은지 원본 확인", ids[0].id);
  }

  const need = {
    dorm: ["dorm"], own: ["lease"], own_goshiwon: ["lease", "biz_reg"],
    friend: ["lease", "residence_confirm", "provider_id"],
    friend_joint: ["lease", "residence_confirm", "provider_id"],
    friend_goshiwon: ["lease", "biz_reg", "residence_confirm", "provider_id"],
  }[scen || ""] || ["lease"];
  return need.map((k) => ({ name: DOC_TYPES[k], ok: !!by[k]?.length }));
}

// ── 전체 ────────────────────────────────────────────────────────────────
/**
 * pages: [{id, no, ocr, kind}], getImg(page) → Promise<{width,height,data}>
 * 반환: 결과 객체(JSON 직렬화 가능)와 쪽별 최종 분류
 */
export async function evaluate(pages, { name = "", received = null, scenario = null, birth = null }, getImg) {
  const r = new Result();
  const kinds = {};
  for (const p of pages) {
    let k = p.kind;
    if (k === "id_card" || k === "passport") k = name && nameSimilarity(name, text(p.ocr)) >= 0.7 ? "own_id" : "provider_id";
    kinds[p.id] = k;
  }
  const by = {};
  for (const p of pages) {
    const q = { ...p, kind: kinds[p.id] };
    (by[q.kind] ||= []).push(q);
    if (rescanNeeded(p.ocr)) r.rescanPages.push(p.no);
  }
  for (const p of by.application || []) checkApplication(p, await getImg(p), name, r);
  for (const p of by.balance || []) checkBalance(p, await getImg(p), name, received, r, by.balance.length);
  if (by.health?.length) checkHealth(by.health, name, received, r, birth);
  const resNeed = await checkResidence(by, name, received, r, scenario, getImg);
  r.checklist = [
    { name: DOC_TYPES.application, ok: !!by.application?.length },
    { name: DOC_TYPES.balance, ok: !!by.balance?.length },
    { name: DOC_TYPES.health, ok: (by.health || []).some((p) => healthKind(p.ocr) !== "월별 정산내역") },
    ...resNeed,
  ];
  return { ...r.toJSON(), pageKinds: kinds };
}
