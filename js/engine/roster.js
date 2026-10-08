// 입시 사이트에서 내려받은 합격자 엑셀 → 학생 명단(요구사항 v4 1.1). 열 제목 핵심어로 자동 연결.
// rows: 시트의 2차원 배열(SheetJS sheet_to_json(header:1, raw:true) 결과)

export const COLUMNS = {
  app_no: ["원서번호", "접수번호"],
  exam_no: ["수험번호"],
  student_no: ["학번"],
  // 한글 성명 열을 먼저 잡아야 '성명' 핵심어가 한글 성명 열에 붙지 않는다
  name_ko: ["한글성명", "국문성명", "한글명", "성명(한글)"],
  name: ["영문성명", "성명(영문)", "영문명", "영문이름", "ENGLISHNAME", "성명", "이름", "NAME"],
  dept: ["학과", "모집단위", "전공"],
  track: ["모집구분", "전형"],
  birth: ["생년월일", "BIRTH"],
  passport_no: ["여권번호", "PASSPORT"],
  nationality: ["국적", "NATIONALITY"],
};

export const COLUMN_LABEL = {
  app_no: "원서번호", exam_no: "수험번호", student_no: "학번", name: "영문 성명", name_ko: "한글 성명",
  dept: "학과", track: "모집구분", birth: "생년월일", passport_no: "여권번호", nationality: "국적",
};

const norm = (v) => String(v ?? "").replace(/\s/g, "").toUpperCase();

function toBirth(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // 엑셀 날짜 일련번호
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").replace(/\D/g, "");
  if (s.length === 8) {
    const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) return dt.toISOString().slice(0, 10);
  }
  return null;
}

/** 제목 행을 찾고 열을 연결한다. {headerRow, mapping, records} */
export function parseRoster(rows) {
  let best = null, bestMap = {};
  rows.slice(0, 10).forEach((row, i) => {
    const cells = (row || []).map(norm);
    const mapping = {};
    for (const [field, keys] of Object.entries(COLUMNS)) {
      for (const k of keys) {
        const j = cells.findIndex((c, jj) => c.includes(k) && !Object.values(mapping).includes(jj));
        if (j >= 0) { mapping[field] = j; break; }
      }
    }
    if (Object.keys(mapping).length > Object.keys(bestMap).length) { best = i; bestMap = mapping; }
  });
  if (best === null || !("name" in bestMap))
    throw new Error("명단 엑셀에서 성명 열을 찾지 못했습니다. 열 제목에 '성명' 또는 '영문성명'이 있어야 합니다.");
  const records = [];
  for (const row of rows.slice(best + 1)) {
    if (!row) continue;
    const rec = {};
    for (const [f, j] of Object.entries(bestMap)) rec[f] = row[j] == null ? "" : String(row[j]).trim();
    if (!rec.name) continue;
    rec.birth = "birth" in bestMap ? toBirth(row[bestMap.birth]) : null;
    records.push(rec);
  }
  const columns = Object.fromEntries(Object.entries(bestMap).map(([f, j]) => [f, rows[best][j]]));
  return { headerRow: best, columns, records };
}
