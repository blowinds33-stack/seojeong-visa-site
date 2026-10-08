// 처리 워커: 쪽 이미지 → PaddleOCR → 쪽 분류 → 명단 매칭 → 판정. 화면이 멈추지 않게 따로 돈다.
import * as store from "./store.js";
import { loadModels, readPage } from "./engine/ocr.js";
import { autoKinds } from "./engine/classify.js";
import { evaluate, guessName } from "./engine/rules.js";
import { findDates, nameSimilarity } from "./engine/textutil.js";

let chain = Promise.resolve();
const send = (m) => self.postMessage(m);

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "process") chain = chain.then(() => processUpload(m.uploadId)).catch((e) => fail(m.uploadId, e));
  if (m.type === "evaluate") chain = chain.then(() => evaluateApplicant(m.applicantId)).catch((e) => send({ type: "error", message: String(e) }));
};

async function fail(uploadId, e) {
  await store.update("uploads", uploadId, { status: "error", error: String(e?.message || e) });
  send({ type: "uploadError", uploadId, message: String(e?.message || e) });
}

async function bitmapOf(pageId) {
  const blob = await store.pageImage(pageId);
  return createImageBitmap(blob);
}

async function imageDataOf(pageId) {
  const bmp = await bitmapOf(pageId);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function processUpload(uploadId) {
  const up = await store.get("uploads", uploadId);
  if (!up || up.status === "done") return;
  await store.update("uploads", uploadId, { status: "processing", error: "" });
  send({ type: "progress", uploadId, stage: "모델 준비" });
  await loadModels((stage) => send({ type: "progress", uploadId, stage }));
  const pages = (await store.byIndex("pages", "uploadId", uploadId)).sort((a, b) => a.no - b.no);
  for (const p of pages) {
    if (p.ocr) continue;
    const bmp = await bitmapOf(p.id);
    const ocr = await readPage(bmp, (done, total) =>
      send({ type: "progress", uploadId, stage: `${p.no}/${pages.length}쪽 읽는 중`, done, total }));
    bmp.close();
    p.ocr = ocr;
    await store.update("pages", p.id, { ocr });
  }
  const kinds = autoKinds(pages.map((p) => p.ocr));
  for (let i = 0; i < pages.length; i++) await store.update("pages", pages[i].id, { autoKind: kinds[i] });

  let applicantId = up.applicantId;
  if (!applicantId) applicantId = await matchApplicant(pages.map((p, i) => ({ ...p, kind: kinds[i] })), up.filename);
  for (const p of pages) await store.update("pages", p.id, { applicantId });
  const a = await store.get("applicants", applicantId);
  if (up.scanDate && !a.received) await store.update("applicants", applicantId, { received: up.scanDate });
  await store.update("uploads", uploadId, { status: "done", applicantId });
  await evaluateApplicant(applicantId);
  send({ type: "uploadDone", uploadId, applicantId });
}

/** 명단에서 학생을 찾는다. 인쇄 서류(잔액증명서·건강보험)의 영문 성명·생년월일이 손글씨보다 믿을 만하다. */
async function matchApplicant(pages, filename) {
  const text = pages.map((p) => p.ocr.lines.map((l) => l.text).join("\n")).join("\n");
  const dates = new Set(findDates(text).map((d) => d.date));
  const roster = (await store.all("applicants")).filter((a) => a.in_roster);
  const scored = roster.map((a) => [nameSimilarity(a.name, text) + (a.birth && dates.has(a.birth) ? 0.15 : 0), a.id])
    .sort((x, y) => y[0] - x[0]);
  if (scored.length && scored[0][0] >= 0.85 && (scored.length === 1 || scored[0][0] - scored[1][0] >= 0.1)) return scored[0][1];
  const name = guessName(pages) || filename.replace(/\.pdf$/i, "");
  return store.put("applicants", { name, in_roster: false, needs_match: roster.length > 0, created: Date.now() });
}

export async function evaluateApplicant(applicantId) {
  const a = await store.get("applicants", applicantId);
  const uploads = await store.byIndex("uploads", "applicantId", applicantId);
  const doneUploads = new Set(uploads.filter((u) => u.status === "done").map((u) => u.id));
  const pages = (await store.byIndex("pages", "applicantId", applicantId))
    .filter((p) => p.ocr && doneUploads.has(p.uploadId))
    .sort((x, y) => x.uploadId - y.uploadId || x.no - y.no);
  if (!a || !pages.length) { await store.del("results", applicantId); send({ type: "evaluated", applicantId }); return; }
  const cache = new Map();
  const getImg = async (p) => {
    if (!cache.has(p.id)) cache.set(p.id, await imageDataOf(p.id));
    return cache.get(p.id);
  };
  const res = await evaluate(
    pages.map((p, i) => ({ id: p.id, no: i + 1, ocr: p.ocr, kind: p.kindOverride || p.autoKind })),
    { name: a.name, received: a.received || null, scenario: a.scenario || null, birth: a.birth || null },
    getImg,
  );
  await store.put("results", { applicantId, data: res, updated: Date.now() });
  send({ type: "evaluated", applicantId });
}
