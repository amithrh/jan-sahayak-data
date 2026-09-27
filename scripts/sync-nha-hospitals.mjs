// Nightly copy of the NHA PM-JAY empanelled hospital directory.
//   node scripts/sync-nha-hospitals.mjs [--out .data/nha-hospitals] [--concurrency 2] [--delay 400]
// Crawls state by state (NHA returns at most 10 records per page), checkpoints each
// state to disk so a rerun resumes, then writes a snapshot, a manifest with total
// cross-checks, and a change log against the previous snapshot.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const outRoot = resolve(args.out ?? new URL("../.data/nha-hospitals", import.meta.url).pathname);
const concurrency = Number(args.concurrency ?? 2);
const delayMs = Number(args.delay ?? 400);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const runDir = join(outRoot, today);
const statesDir = join(runDir, "states");
mkdirSync(statesDir, { recursive: true });

const HOSPITAL_URL = "https://apisprod.nha.gov.in/pmjay/prodhem/hem/external/hospital/list";
const STATE_URL = "https://apisprod.nha.gov.in/pmjay/prodump/ump/ump/fetch/statelist";
const headers = {
  Accept: "application/json, text/plain, */*",
  Appname: "HEM",
  "Request-Agent": "web",
  Origin: "https://hem.nha.gov.in",
  Referer: "https://hem.nha.gov.in/",
  "Content-Type": "application/json; charset=UTF-8",
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function nha(url, body, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return JSON.parse(await response.text());
    } catch (error) {
      lastError = error;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

const hospitalPage = (stateCode, pageNo) => nha(HOSPITAL_URL, {
  ...(stateCode ? { stateCode: String(stateCode) } : {}),
  facilityName: "", pincode: "", pageNo, size: 10, card: "hosp_type_code", value: "",
});

async function crawlState(state) {
  const file = join(statesDir, `${state.code}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.complete) return saved;
  }
  const first = await hospitalPage(state.code, 1);
  const records = [...first.content];
  for (let page = 2; page <= first.totalPages; page++) {
    await sleep(delayMs);
    records.push(...(await hospitalPage(state.code, page)).content);
    if (page % 50 === 0) console.log(`  ${state.name}: page ${page}/${first.totalPages}`);
  }
  const result = { ...state, reportedTotal: first.totalElements, pages: first.totalPages, records, fetchedAt: new Date().toISOString(), complete: true };
  writeFileSync(file, JSON.stringify(result));
  console.log(`${state.name}: ${records.length}/${first.totalElements}`);
  return result;
}

const startedAt = new Date().toISOString();
const stateList = (await nha(STATE_URL)).StateList;
// Codes above 38 are programmes (CGHS, CAPF, ...), not states; the nationwide total covers them.
const states = Object.entries(stateList)
  .map(([name, code]) => ({ name, code: Number(code) }))
  .filter((state) => state.code >= 1 && state.code <= 38)
  .sort((a, b) => a.code - b.code);
const nationalTotal = (await hospitalPage(null, 1)).totalElements;
console.log(`NHA reports ${nationalTotal} hospitals nationwide across ${states.length} states/UTs. Writing to ${runDir}`);

const results = [];
const queue = [...states];
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let state = queue.shift(); state; state = queue.shift()) {
    try { results.push(await crawlState(state)); }
    catch (error) { console.error(`${state.name} failed: ${error.message}`); results.push({ ...state, complete: false, error: error.message, records: [] }); }
  }
}));

// Pages are unsorted on NHA's side, so records can shift between pages mid-crawl; dedupe by hospitalId.
const byId = new Map();
let duplicates = 0;
for (const state of results) for (const record of state.records) {
  const id = record.hospitalId ?? record.facilityId;
  if (byId.has(id)) duplicates++;
  byId.set(id, record);
}
const hospitals = [...byId.values()].sort((a, b) => (a.stateCode - b.stateCode) || String(a.facilityId).localeCompare(String(b.facilityId)));
writeFileSync(join(runDir, "hospitals.json"), JSON.stringify(hospitals));

const csvColumns = ["hospitalId", "facilityId", "hfrId", "hospName", "hospTypeCode", "stateCode", "districtCode", "hospPin", "hospAddress", "hospContactNumber", "hospLatitude", "hospLongitude", "specialityCode", "empaneledDate", "deempanelStatus", "updatedDate"];
const csvCell = (value) => value == null ? "" : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
writeFileSync(join(runDir, "hospitals.csv"), [csvColumns.join(","), ...hospitals.map((h) => csvColumns.map((c) => csvCell(h[c])).join(","))].join("\n"));

// Change log against the most recent earlier snapshot.
const previousDay = readdirSync(outRoot).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < today).sort().pop();
let changes = null;
if (previousDay && existsSync(join(outRoot, previousDay, "hospitals.json"))) {
  const before = new Map(JSON.parse(readFileSync(join(outRoot, previousDay, "hospitals.json"), "utf8")).map((h) => [h.hospitalId ?? h.facilityId, h]));
  const tracked = ["hospName", "hospAddress", "hospContactNumber", "hospTypeCode", "specialityCode", "deempanelStatus", "hospLatitude", "hospLongitude", "hospPin"];
  const added = [], removed = [], changed = [];
  for (const [id, h] of byId) {
    const old = before.get(id);
    if (!old) added.push(h.facilityId);
    else {
      const fields = tracked.filter((field) => String(old[field] ?? "") !== String(h[field] ?? ""));
      if (fields.length) changed.push({ facilityId: h.facilityId, fields });
    }
  }
  for (const [id, h] of before) if (!byId.has(id)) removed.push(h.facilityId);
  changes = { comparedWith: previousDay, added, removed, changed };
  writeFileSync(join(runDir, "changes.json"), JSON.stringify(changes, null, 1));
}

const stateTotals = results.map(({ code, name, reportedTotal, records, complete, error }) => ({ code, name, reportedTotal, collected: records.length, complete, ...(error ? { error } : {}) })).sort((a, b) => a.code - b.code);
const sumStates = stateTotals.reduce((sum, state) => sum + (state.reportedTotal ?? 0), 0);
const manifest = {
  source: "NHA Hospital Engagement Module (hem.nha.gov.in)", startedAt, finishedAt: new Date().toISOString(),
  nationalTotal, sumOfStateTotals: sumStates, uniqueHospitals: hospitals.length, duplicatesAcrossPages: duplicates,
  incompleteStates: stateTotals.filter((state) => !state.complete || state.collected < state.reportedTotal).map((state) => state.name),
  changes: changes && { comparedWith: changes.comparedWith, added: changes.added.length, removed: changes.removed.length, changed: changes.changed.length },
  stateTotals,
};
writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`Done: ${hospitals.length} unique hospitals (national ${nationalTotal}, states sum ${sumStates}). Incomplete: ${manifest.incompleteStates.join(", ") || "none"}`);
if (manifest.incompleteStates.length) process.exitCode = 1;
