// 쪽 분류. OCR 글자의 핵심어로 서류 종류를 정한다. 담당자가 화면에서 바로잡을 수 있다.
import { compact } from "./textutil.js";

export const DOC_TYPES = {
  application: "통합신청서",
  balance: "잔액증명서",
  health: "건강보험",
  lease: "임대차(월세)계약서",
  residence_confirm: "거주·숙소제공 확인서",
  dorm: "기숙사 확인서",
  biz_reg: "사업자등록증",
  provider_id: "제공자 신분증",
  own_id: "본인 여권·외국인등록증(참고)",
  other: "기타 서류",
};

const RULES = [
  ["application", ["통합신청서", "APPLICATIONFORM", "REPORTFORM", "신청/신고선택"], 3],
  ["balance", ["잔액증명서", "잔액·잔고증명서", "잔고증명", "CERTIFICATEOFDEPOSIT", "예금잔액"], 3],
  ["health", ["보험료납부확인서", "보험료완납증명서", "건강보험료완납", "월별정산내역", "국민건강보험공단"], 3],
  ["residence_confirm", ["숙소제공확인서", "숙소제공", "CONFIRMATIONOFRESIDENCE"], 4],
  ["dorm", ["기숙사입사확인서", "기숙사확인서", "입사확인서"], 4],
  ["biz_reg", ["사업자등록증"], 3],
  ["lease", ["임대차계약서", "월세계약서", "임대차계약", "임대보증금", "임대인", "임차인", "소재지"], 1],
  ["id_card", ["RESIDENCECARD", "외국인등록증", "운전면허증", "DRIVER", "주민등록증", "체류기간(DURATIONOFSTAY"], 2],
  ["passport", ["PASSPORT"], 1],
  ["other", ["성적증명서", "재학증명서", "수료증명서", "졸업증명서", "이수증", "TRANSCRIPT", "DIPLOMA",
    "CERTIFICATEOF", "사회통합프로그램", "공용영수증", "GRADE-SHEET", "CERTIFY"], 3],
];

const pageText = (pg) => pg.lines.map((l) => l.text).join("\n");

export function classify(pg) {
  const t = compact(pageText(pg));
  const scores = {};
  for (const [kind, words, w] of RULES) {
    const hits = words.filter((k) => t.includes(k)).length;
    if (hits) scores[kind] = (scores[kind] || 0) + hits * w;
  }
  if (pg.lines.some((l) => /^[A-Z0-9<]{28,}$/.test(compact(l.text)) && (l.text.match(/</g) || []).length >= 2))
    scores.passport = (scores.passport || 0) + 6;
  // 거주제공 확인서·건강보험에도 '임대'·'임차'가 나오므로 계약서는 핵심어 2개 이상일 때만
  if ((scores.lease || 0) < 2) delete scores.lease;
  const keys = Object.keys(scores);
  if (!keys.length) return "other";
  const best = keys.reduce((a, b) => (scores[b] > scores[a] ? b : a));
  return best;
}

export function isContinuation(prevKind, pg) {
  const t = compact(pageText(pg));
  return prevKind === "lease" && (t.includes("임차인") || t.includes("임대인") || t.includes("특약"));
}

export function autoKinds(pages) {
  const kinds = [];
  let prev = null;
  for (const pg of pages) {
    let k = classify(pg);
    if (k === "other" && isContinuation(prev, pg)) k = prev;
    kinds.push(k);
    prev = k;
  }
  return kinds;
}
