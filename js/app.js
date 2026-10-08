// 비자서류검증 화면. 자료는 이 브라우저(IndexedDB)에만 저장한다.
import * as store from "./store.js";
import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import { DOC_TYPES } from "./engine/classify.js";
import { SCENARIOS, SEVERITY, VERDICT_LABEL } from "./engine/rules.js";
import { COLUMN_LABEL, parseRoster } from "./engine/roster.js";
import { daysBetween, mkDate } from "./engine/textutil.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const KIND_CHOICES = { ...DOC_TYPES, id_card: "신분증(자동 구분)", passport: "여권(자동 구분)" };
const DPI = 200;
const $app = document.getElementById("app");
const progress = new Map(); // uploadId → 진행 문구
let flash = "";
let objectUrls = [];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 한국 시간

// ── 처리 워커 ───────────────────────────────────────────────────────────
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let renderTimer = null;
const rerender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(route, 300); };
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "progress") progress.set(m.uploadId, m.done ? `${m.stage} (${m.done}/${m.total}줄)` : m.stage);
  if (m.type === "uploadDone" || m.type === "uploadError") progress.delete(m.uploadId);
  if (m.type === "uploadError") flash = `처리 실패: ${m.message}`;
  if (m.type === "error") flash = `판정 오류: ${m.message}`;
  // 진행 문구만 바뀔 때는 표시 부분만 고친다(입력 중인 화면이 다시 그려지지 않게)
  if (m.type === "progress") updateProgressText(); else rerender();
};

function updateProgressText() {
  document.querySelectorAll("[data-upload]").forEach((el) => {
    el.textContent = progress.get(Number(el.dataset.upload)) || el.textContent;
  });
}

async function resumeQueue() {
  for (const u of await store.all("uploads")) {
    if (u.status === "queued" || u.status === "processing") worker.postMessage({ type: "process", uploadId: u.id });
    if (u.status === "rendering") await store.update("uploads", u.id, { status: "error", error: "쪽 나누기 중 창이 닫혔습니다. 다시 올려 주세요." });
  }
}

// ── 파일 받기 ───────────────────────────────────────────────────────────
function scanDateFromName(name) {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? mkDate(+m[1], +m[2], +m[3]) : null;
}

function scanDateFromPdf(info) {
  // 'D:20261007065210Z' (UTC) → 한국 날짜
  const m = String(info?.CreationDate || "").match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + (/Z$|Z'?$/.test(info.CreationDate) ? 9 * 3600 * 1000 : 0);
  return new Date(t).toISOString().slice(0, 10);
}

async function addPdf(file, applicantId = null) {
  const uploadId = await store.put("uploads", { applicantId, filename: file.name, status: "rendering", created: Date.now() });
  progress.set(uploadId, "쪽 나누는 중");
  rerender();
  try {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let scanDate = scanDateFromName(file.name);
    if (!scanDate) { try { scanDate = scanDateFromPdf((await pdf.getMetadata()).info); } catch { /* 없음 */ } }
    for (let i = 1; i <= pdf.numPages; i++) {
      progress.set(uploadId, `쪽 나누는 중 ${i}/${pdf.numPages}`);
      updateProgressText();
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: DPI / 72 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
      const pageId = await store.put("pages", { uploadId, applicantId, no: i, width: c.width, height: c.height });
      await store.put("images", { pageId, blob });
      page.cleanup();
    }
    await pdf.destroy();
    await store.update("uploads", uploadId, { status: "queued", scanDate });
    progress.set(uploadId, "대기 중");
    worker.postMessage({ type: "process", uploadId });
  } catch (e) {
    await store.update("uploads", uploadId, { status: "error", error: `PDF를 열지 못했습니다: ${e.message || e}` });
    progress.delete(uploadId);
  }
  rerender();
}

async function importRoster(file) {
  /* global XLSX */
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const { columns, records } = parseRoster(rows);
  const existing = (await store.all("applicants")).filter((a) => a.in_roster);
  let added = 0, updated = 0;
  for (const rec of records) {
    const hit = (rec.app_no && existing.find((a) => a.app_no === rec.app_no))
      || (rec.student_no && existing.find((a) => a.student_no === rec.student_no))
      || existing.find((a) => a.name === rec.name);
    if (hit) { await store.update("applicants", hit.id, rec); updated++; }
    else { await store.put("applicants", { ...rec, in_roster: true, created: Date.now() }); added++; }
  }
  const cols = Object.entries(columns).map(([k, v]) => `${COLUMN_LABEL[k]}←'${v}'`).join(", ");
  return `명단 반영: 추가 ${added}명, 갱신 ${updated}명 (${cols})`;
}

// ── 공통 ────────────────────────────────────────────────────────────────
async function loadState() {
  const [applicants, uploads, results] = await Promise.all([store.all("applicants"), store.all("uploads"), store.all("results")]);
  const res = new Map(results.map((r) => [r.applicantId, r.data]));
  return { applicants, uploads, res };
}

function ddayOf(res, received) {
  if (!res?.balanceExpiry) return null;
  return daysBetween(received || today(), res.balanceExpiry);
}

const ddayHtml = (d) => d === null ? "-" : `<span class="dday ${d < 0 ? "v-fail" : d <= 7 ? "v-warn" : ""}">${d < 0 ? "만료" : `D-${d}`}</span>`;

function statusOf(a, res, busy) {
  if (busy) return "processing";
  return res ? res.overall : "none";
}

const STATUS_LABEL = { ...VERDICT_LABEL, missing: "서류 누락", none: "미제출", processing: "처리중" };

// ── 목록 ────────────────────────────────────────────────────────────────
async function renderList(params) {
  const { applicants, uploads, res } = await loadState();
  const busyIds = new Set(uploads.filter((u) => ["rendering", "queued", "processing"].includes(u.status)).map((u) => u.applicantId));
  const pendingNew = uploads.filter((u) => ["rendering", "queued", "processing"].includes(u.status) && !u.applicantId);
  const errors = uploads.filter((u) => u.status === "error" && !u.applicantId).slice(-5);
  let rows = applicants.map((a) => {
    const r = res.get(a.id);
    return { a, r, status: statusOf(a, r, busyIds.has(a.id)), dday: ddayOf(r, a.received) };
  });
  const count = (f) => rows.filter(f).length;
  const tiles = [
    ["", "전체", rows.length], ["none", "미제출", count((x) => x.status === "none")],
    ["processing", "처리중", count((x) => x.status === "processing") + pendingNew.length],
    ["pass", "통과", count((x) => x.status === "pass")], ["warn", "주의", count((x) => x.status === "warn")],
    ["check", "확인 필요", count((x) => x.status === "check")], ["fail", "불가", count((x) => x.status === "fail")],
    ["missing", "서류 누락", count((x) => x.status === "missing")], ["match", "매칭 필요", count((x) => x.a.needs_match)],
    ["confirmed", "확인 완료", count((x) => x.a.confirmed)],
  ];
  const f = params.get("f") || "", sort = params.get("sort") || "", q = (params.get("q") || "").trim().toUpperCase();
  if (f === "match") rows = rows.filter((x) => x.a.needs_match);
  else if (f === "confirmed") rows = rows.filter((x) => x.a.confirmed);
  else if (f) rows = rows.filter((x) => x.status === f);
  if (q) rows = rows.filter((x) => ["name", "name_ko", "student_no", "app_no", "exam_no"].some((k) => String(x.a[k] || "").toUpperCase().includes(q)));
  rows.sort(sort === "dday"
    ? (x, y) => (x.dday === null) - (y.dday === null) || (x.dday ?? 0) - (y.dday ?? 0)
    : (x, y) => String(y.a.received || "").localeCompare(String(x.a.received || "")) || y.a.id - x.a.id);

  $app.innerHTML = `
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
  <section class="card">
    <div class="card-head"><h2>서류 올리기</h2>
      ${pendingNew.length ? pendingNew.map((u) => `<span class="pill busy">${esc(u.filename)}: <span data-upload="${u.id}">${esc(progress.get(u.id) || "대기 중")}</span></span>`).join(" ") : ""}
    </div>
    <div class="uploads">
      <label class="up"><span>합격자 명단 엑셀 <small>입시 사이트에서 내려받은 .xlsx</small></span>
        <input type="file" id="roster" accept=".xlsx,.xlsm,.xls"></label>
      <label class="up"><span>스캔 PDF <small>1인 1PDF · 여러 개 선택 가능 · 컬러 스캔</small></span>
        <input type="file" id="pdfs" accept=".pdf" multiple></label>
    </div>
    ${errors.map((e) => `<div class="flash err">처리 실패: ${esc(e.filename)} — ${esc(e.error)}</div>`).join("")}
  </section>
  <nav class="tiles">${tiles.map(([k, l, n]) => `<a class="tile t-${k || "all"} ${f === k ? "on" : ""}" href="#/?f=${k}&sort=${sort}"><b>${n}</b> ${l}</a>`).join("")}</nav>
  <section class="card">
    <div class="card-head"><h2>접수 목록</h2>
      <form class="search" id="search">
        <input name="q" value="${esc(params.get("q") || "")}" placeholder="성명·학번·원서번호">
        <select name="sort"><option value="">접수일 순</option><option value="dday" ${sort === "dday" ? "selected" : ""}>잔액증명서 잔여일 짧은 순</option></select>
        <button>조회</button>
      </form>
    </div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>접수일</th><th>학번</th><th>성명</th><th>모집구분 / 학과</th><th>체류지</th><th>검증</th><th>잔액 유효</th><th>종합</th><th>작업</th></tr></thead>
      <tbody>${rows.map(({ a, r, status, dday }) => `<tr>
        <td>${esc(a.received || "-")}</td><td>${esc(a.student_no || a.app_no || "-")}</td>
        <td class="name">${esc(a.name)} ${a.needs_match ? '<span class="tag red">매칭 필요</span>' : !a.in_roster ? '<span class="tag">명단 외</span>' : ""}${a.confirmed ? '<span class="tag green">확인 완료</span>' : ""}</td>
        <td class="small">${esc(a.track || "")}<br>${esc(a.dept || "")}</td>
        <td class="small">${r ? esc(SCENARIOS[r.scenario] || "-") : "-"}</td>
        <td>${r ? ["pass", "warn", "check", "fail", "missing"].map((k) => `<span class="cnt v-${k}">${r.counts[k]}</span>`).join("") : "-"}</td>
        <td>${ddayHtml(dday)}</td>
        <td><span class="badge ${status === "processing" ? "busy" : status === "none" ? "v-info" : `v-${status}`}">${STATUS_LABEL[status]}</span></td>
        <td><a class="btn" href="#/a/${a.id}">결과</a></td></tr>`).join("")
        || `<tr><td colspan="9" class="empty">명단 엑셀이나 스캔 PDF를 올리면 여기에 표시됩니다.</td></tr>`}</tbody>
    </table></div>
  </section>`;
  flash = "";
  document.getElementById("roster").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { flash = await importRoster(file); } catch (err) { flash = `명단 오류: ${err.message}`; }
    route();
  };
  document.getElementById("pdfs").onchange = (e) => {
    const files = [...e.target.files];
    flash = `PDF ${files.length}개를 접수했습니다. 1쪽에 약 10~20초 걸리며, 이 창을 열어 두면 계속 처리합니다.`;
    (async () => { for (const f of files) await addPdf(f); })();
  };
  document.getElementById("search").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    location.hash = `#/?f=${f}&q=${encodeURIComponent(fd.get("q"))}&sort=${fd.get("sort")}`;
  };
}

// ── 상세 ────────────────────────────────────────────────────────────────
async function renderDetail(id) {
  const a = await store.get("applicants", id);
  if (!a) { $app.innerHTML = `<div class="flash err">학생을 찾을 수 없습니다.</div><a class="btn" href="#/">목록</a>`; return; }
  const r = (await store.get("results", id))?.data || null;
  const uploads = await store.byIndex("uploads", "applicantId", id);
  const pages = (await store.byIndex("pages", "applicantId", id)).sort((x, y) => x.uploadId - y.uploadId || x.no - y.no);
  const busy = uploads.some((u) => ["rendering", "queued", "processing"].includes(u.status));
  const pageNo = new Map(pages.map((p, i) => [p.id, i + 1]));
  const groups = new Map();
  for (const it of r?.items || []) { if (!groups.has(it.doc)) groups.set(it.doc, []); groups.get(it.doc).push(it); }
  const docVerdict = (its) => its.filter((i) => i.verdict !== "info").map((i) => i.verdict).reduce((m, v) => (SEVERITY[v] > SEVERITY[m] ? v : m), "info");
  const roster = !a.in_roster ? (await store.all("applicants")).filter((x) => x.in_roster).sort((x, y) => x.name.localeCompare(y.name)) : [];
  const sameLease = [];
  if (r?.leaseKey?.length >= 8) {
    for (const o of await store.all("results")) {
      if (o.applicantId !== id && o.data.leaseKey === r.leaseKey) {
        const oa = await store.get("applicants", o.applicantId);
        if (oa) sameLease.push(oa);
      }
    }
  }
  const dday = ddayOf(r, a.received);
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
  const thumbs = await Promise.all(pages.map(async (p) => {
    const blob = await store.pageImage(p.id);
    const url = blob ? URL.createObjectURL(blob) : "";
    if (url) objectUrls.push(url);
    return url;
  }));
  const c = r?.counts;

  $app.innerHTML = `
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
  <section class="card head">
    <div><h1>${esc(a.name)} ${a.name_ko ? `<small>${esc(a.name_ko)}</small>` : ""}</h1>
      <div class="meta">${a.student_no ? `학번 ${esc(a.student_no)} · ` : ""}${a.app_no ? `원서 ${esc(a.app_no)} · ` : ""}${esc(a.track || "")} ${esc(a.dept || "")}
      ${a.needs_match ? '<span class="tag red">매칭 필요</span>' : !a.in_roster ? '<span class="tag">명단 외</span>' : ""}</div></div>
    <div class="head-actions">
      <label class="inline">서류 접수일 <input type="date" id="received" value="${esc(a.received || "")}"></label>
      <button id="confirm" class="${a.confirmed ? "primary" : ""}">${a.confirmed ? "✓ 확인 완료" : "확인 완료 표시"}</button>
      <a class="btn" href="#/">목록</a>
    </div>
  </section>
  ${busy ? `<div class="flash">서류를 읽는 중입니다: ${uploads.filter((u) => progress.has(u.id)).map((u) => `<span data-upload="${u.id}">${esc(progress.get(u.id))}</span>`).join(", ") || "대기 중"}. 이 창을 열어 두세요.</div>` : ""}
  ${uploads.filter((u) => u.status === "error").map((u) => `<div class="flash err">처리 실패: ${esc(u.filename)} — ${esc(u.error)}</div>`).join("")}
  ${roster.length ? `<section class="card warnbox"><form id="assign" class="inline"><b>명단 학생과 연결</b>
     <span class="small">자동으로 찾지 못했습니다. 이 서류의 주인을 고르세요.</span>
     <select name="target" required><option value="">명단에서 선택</option>${roster.map((x) => `<option value="${x.id}">${esc(x.name)} ${esc(x.student_no || "")} ${esc(x.dept || "")}</option>`).join("")}</select>
     <button class="primary">연결</button></form></section>` : ""}
  ${r ? `
  <nav class="summary">
    ${[["pass", "통과"], ["warn", "주의"], ["check", "확인 필요"], ["fail", "불가"], ["missing", "누락"]].map(([k, l]) => `<div class="s v-${k}"><span>${l}</span><b>${c[k]}</b></div>`).join("")}
    <div class="s ${dday !== null && dday < 0 ? "v-fail" : dday !== null && dday <= 7 ? "v-warn" : ""}"><span>잔액증명서 유효</span>
      <b>${dday === null ? "-" : dday < 0 ? "만료" : `D-${dday}`}</b>${r.balanceExpiry ? `<small>${esc(r.balanceExpiry)}까지</small>` : ""}</div>
  </nav>
  <section class="card">
    <div class="card-head"><h2>서류 완비</h2>
      <label class="inline">체류지 유형 <select id="scenario">
        <option value="">자동 판단${!a.scenario && r.scenario ? ` (${esc(SCENARIOS[r.scenario])})` : ""}</option>
        ${Object.entries(SCENARIOS).map(([k, v]) => `<option value="${k}" ${a.scenario === k ? "selected" : ""}>${esc(v)}</option>`).join("")}
      </select></label></div>
    <p class="small muted">${esc(r.scenarioReason)}</p>
    ${sameLease.length ? `<p class="small">같은 계약서를 낸 학생: ${sameLease.map((o) => `<a href="#/a/${o.id}">${esc(o.name)}</a>`).join(", ")} — 거주지 제공자의 신분증이 그 학생 서류에 있는지 함께 보세요.</p>` : ""}
    <ul class="checklist">${r.checklist.map((ck) => `<li class="${ck.ok ? "ok" : "no"}">${ck.ok ? "○" : "✕"} ${esc(ck.name)}${ck.ok ? "" : " <b>누락</b>"}</li>`).join("")}</ul>
    <p class="small muted">본인 여권·외국인등록증은 입학서류에서 받으므로 필요 서류가 아닙니다.</p>
    ${r.rescanPages.length ? `<p class="flash err">재스캔 요청: ${r.rescanPages.join(", ")}쪽 글자를 거의 읽지 못했습니다(흐림·어두움·사진 촬영).</p>` : ""}
  </section>
  ${[...groups.entries()].map(([doc, its]) => `
  <section class="card doc v-border-${docVerdict(its)}"><div class="card-head"><h2>${esc(doc)}</h2></div>
    <table class="items"><colgroup><col class="c-label"><col><col class="c-badge"><col class="c-why"><col class="c-pg"></colgroup>
    ${its.map((it) => `<tr class="row-${it.verdict}"><th>${esc(it.label)}</th><td class="val">${esc(it.value)}</td>
      <td><span class="badge v-${it.verdict}">${VERDICT_LABEL[it.verdict]}</span></td><td class="why">${esc(it.reason)}</td>
      <td class="pg">${it.pageId ? `<a href="#/a/${id}" data-page="${it.pageId}">${pageNo.get(it.pageId) || ""}쪽</a>` : ""}</td></tr>`).join("")}
    </table></section>`).join("")}` : ""}
  <section class="card" id="pages"><div class="card-head"><h2>쪽별 분류</h2><span class="small muted">분류가 틀리면 바꾸세요. 바로 다시 판정합니다.</span></div>
    <div class="thumbs">${pages.map((p, i) => {
      const finalKind = r?.pageKinds?.[p.id];
      return `<figure id="page-${p.id}" class="thumb ${p.kindOverride ? "manual" : ""}">
        ${thumbs[i] ? `<a href="${thumbs[i]}" target="_blank" rel="noopener"><img src="${thumbs[i]}" alt="${i + 1}쪽"></a>` : ""}
        <figcaption><b>${i + 1}쪽</b>
          <select data-kind="${p.id}"><option value="">자동: ${esc(KIND_CHOICES[p.autoKind] || (p.ocr ? p.autoKind : "읽는 중"))}</option>
          ${Object.entries(KIND_CHOICES).map(([k, v]) => `<option value="${k}" ${p.kindOverride === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
          ${finalKind && finalKind !== p.autoKind && !p.kindOverride ? `<small>→ ${esc(KIND_CHOICES[finalKind] || finalKind)}</small>` : ""}
        </figcaption></figure>`;
    }).join("") || '<p class="muted">아직 서류가 없습니다.</p>'}</div>
  </section>
  <section class="card">
    <label class="up"><span>보완 제출 <small>나중에 받은 서류(예: 거주제공 확인서)를 이 학생에게 추가</small></span>
      <input type="file" id="more" accept=".pdf" multiple></label>
    <ul class="small muted">${uploads.map((u) => `<li>${esc(u.filename)} · 스캔일 ${esc(u.scanDate || "-")} · ${{ rendering: "쪽 나누는 중", queued: "대기", processing: "처리 중", done: "완료", error: "오류" }[u.status]}</li>`).join("")}</ul>
    <button id="delete" class="danger">이 학생 자료 삭제</button>
  </section>`;
  flash = "";

  const reEval = () => worker.postMessage({ type: "evaluate", applicantId: id });
  document.getElementById("received").onchange = async (e) => { await store.update("applicants", id, { received: e.target.value || null }); reEval(); };
  document.getElementById("confirm").onclick = async () => { await store.update("applicants", id, { confirmed: !a.confirmed }); route(); };
  document.getElementById("scenario")?.addEventListener("change", async (e) => { await store.update("applicants", id, { scenario: e.target.value || null }); reEval(); });
  document.querySelectorAll("[data-kind]").forEach((sel) => sel.onchange = async () => {
    await store.update("pages", Number(sel.dataset.kind), { kindOverride: sel.value || null }); reEval();
  });
  document.querySelectorAll("[data-page]").forEach((el) => el.onclick = (e) => {
    e.preventDefault();
    const t = document.getElementById(`page-${el.dataset.page}`);
    t?.scrollIntoView({ behavior: "smooth", block: "center" });
    t?.classList.add("flashpage"); setTimeout(() => t?.classList.remove("flashpage"), 1600);
  });
  document.getElementById("more").onchange = (e) => {
    const files = [...e.target.files];
    flash = `보완 서류 ${files.length}개를 접수했습니다.`;
    (async () => { for (const f of files) await addPdf(f, id); })();
  };
  document.getElementById("assign")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const target = Number(new FormData(e.target).get("target"));
    for (const u of uploads) await store.update("uploads", u.id, { applicantId: target });
    for (const p of pages) await store.update("pages", p.id, { applicantId: target });
    const t = await store.get("applicants", target);
    if (!t.received && a.received) await store.update("applicants", target, { received: a.received });
    await store.del("results", id);
    await store.del("applicants", id);
    worker.postMessage({ type: "evaluate", applicantId: target });
    flash = "서류를 명단 학생에게 연결했습니다";
    location.hash = `#/a/${target}`;
  });
  document.getElementById("delete").onclick = async () => {
    if (!confirm(`${a.name} 학생의 서류·판정을 이 브라우저에서 모두 지웁니다. 되돌릴 수 없습니다.`)) return;
    await store.deleteApplicant(id);
    flash = "삭제했습니다";
    location.hash = "#/";
  };
}

// ── 경로 ────────────────────────────────────────────────────────────────
async function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const m = path.match(/^\/a\/(\d+)/);
  try {
    if (m) await renderDetail(Number(m[1]));
    else await renderList(new URLSearchParams(qs || ""));
  } catch (e) {
    $app.innerHTML = `<div class="flash err">화면 오류: ${esc(e.message || e)}</div>`;
    console.error(e);
  }
}

window.addEventListener("hashchange", route);
(async () => {
  try { await navigator.storage?.persist?.(); } catch { /* 선택 사항 */ }
  await resumeQueue();
  route();
  const est = await navigator.storage?.estimate?.();
  if (est) document.getElementById("usage").textContent = `이 브라우저 저장 사용량 ${(est.usage / 1048576).toFixed(0)}MB`;
  document.getElementById("threads").textContent = crossOriginIsolated ? "다중 스레드 처리" : "단일 스레드 처리(느림)";
})();
