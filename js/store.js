// 브라우저 저장소(IndexedDB). 기존 출장 사이트처럼 자료는 이 브라우저 안에만 남는다.
// 화면과 처리 워커가 함께 쓴다.
const DB_NAME = "visa-doc-check";
const VERSION = 1;
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("applicants", { keyPath: "id", autoIncrement: true });
      const up = db.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
      up.createIndex("applicantId", "applicantId");
      up.createIndex("status", "status");
      const pg = db.createObjectStore("pages", { keyPath: "id", autoIncrement: true });
      pg.createIndex("uploadId", "uploadId");
      pg.createIndex("applicantId", "applicantId");
      db.createObjectStore("images", { keyPath: "pageId" }); // 쪽 이미지(JPEG)는 따로 둔다
      db.createObjectStore("results", { keyPath: "applicantId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, key) => tx(store, "readonly", (t) => wrap(t.objectStore(store).get(key)));
export const all = (store) => tx(store, "readonly", (t) => wrap(t.objectStore(store).getAll()));
export const byIndex = (store, index, key) => tx(store, "readonly", (t) => wrap(t.objectStore(store).index(index).getAll(key)));
export const put = (store, value) => tx(store, "readwrite", (t) => wrap(t.objectStore(store).put(value)));
export const del = (store, key) => tx(store, "readwrite", (t) => wrap(t.objectStore(store).delete(key)));

export async function update(store, key, patch) {
  return tx(store, "readwrite", async (t) => {
    const s = t.objectStore(store);
    const cur = await wrap(s.get(key));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await wrap(s.put(next));
    return next;
  });
}

/** 학생과 그 학생의 업로드·쪽·이미지·판정을 모두 지운다. */
export async function deleteApplicant(id) {
  const pages = await byIndex("pages", "applicantId", id);
  const uploads = await byIndex("uploads", "applicantId", id);
  await tx(["applicants", "uploads", "pages", "images", "results"], "readwrite", (t) => {
    for (const p of pages) { t.objectStore("pages").delete(p.id); t.objectStore("images").delete(p.id); }
    for (const u of uploads) t.objectStore("uploads").delete(u.id);
    t.objectStore("results").delete(id);
    t.objectStore("applicants").delete(id);
  });
}

/** 업로드 하나에 딸린 쪽 이미지 Blob */
export async function pageImage(pageId) {
  const r = await get("images", pageId);
  return r ? r.blob : null;
}
