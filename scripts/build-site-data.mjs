// Turns the latest NHA hospital copy and the PIN index into static files the site loads on demand.
//   node scripts/build-site-data.mjs [--data .data] [--pincodes data/pincodes.json] [--out .pages/data]
// Output (all served as static assets):
//   meta.json                     snapshot date, counts and sources
//   pincodes/<first 3 digits>.json  { pin: [lat, lon, district, state] }
//   tiles/<row>_<col>.json         hospitals with coordinates in a 0.5° cell, for PIN distance search
//   states/<stateCode>.json        every hospital in a state, for state/district/name search
// Hospital rows are tuples in the order of the Row type in the site's lib/local-directory.ts, to keep files small.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const dataDir = resolve(args.data ?? new URL("../.data", import.meta.url).pathname);
const outDir = resolve(args.out ?? new URL("../.pages/data", import.meta.url).pathname);
const TILE_DEGREES = 0.5;

const snapshot = readdirSync(join(dataDir, "nha-hospitals")).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().pop();
if (!snapshot) throw new Error(`No NHA snapshot in ${dataDir}/nha-hospitals`);
const manifest = JSON.parse(readFileSync(join(dataDir, "nha-hospitals", snapshot, "manifest.json"), "utf8"));
if (manifest.incompleteStates?.length) throw new Error(`Snapshot ${snapshot} is incomplete: ${manifest.incompleteStates.join(", ")}`);
const hospitals = JSON.parse(readFileSync(join(dataDir, "nha-hospitals", snapshot, "hospitals.json"), "utf8"));
// A sudden large drop more likely means NHA served partial data than that hospitals left the scheme.
const previousSnapshot = readdirSync(join(dataDir, "nha-hospitals")).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < snapshot).sort().pop();
const previousManifest = previousSnapshot && join(dataDir, "nha-hospitals", previousSnapshot, "manifest.json");
if (previousManifest && existsSync(previousManifest)) {
  const previousCount = JSON.parse(readFileSync(previousManifest, "utf8")).uniqueHospitals;
  if (hospitals.length < previousCount * 0.95 && !args.force) {
    throw new Error(`Snapshot ${snapshot} has ${hospitals.length} hospitals, more than 5% below ${previousSnapshot} (${previousCount}). Pass --force 1 if this is genuine.`);
  }
}
// The PIN index changes rarely; the copy committed in data/ is what the nightly workflow uses.
const pinIndex = JSON.parse(readFileSync(resolve(args.pincodes ?? new URL("../data/pincodes.json", import.meta.url).pathname), "utf8"));

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
for (const folder of ["pincodes", "tiles", "states"]) mkdirSync(join(outDir, folder), { recursive: true });

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const inIndia = (lat, lon) => lat > 6 && lat < 37.5 && lon > 68 && lon < 97.5;
const phone = (value) => /\d{6,}/.test(String(value ?? "")) ? clean(value) : "";

// [id, name, address, phone, type, lat, lon, specialityCodes, stateCode, districtCode, empanelledOn]
function row(hospital) {
  const lat = Number(hospital.hospLatitude), lon = Number(hospital.hospLongitude);
  const located = inIndia(lat, lon);
  return [
    clean(hospital.facilityId), clean(hospital.hospName), clean(hospital.hospAddress), phone(hospital.hospContactNumber),
    hospital.hospTypeCode === "P" ? "P" : hospital.hospTypeCode === "G" ? "G" : "",
    located ? Number(lat.toFixed(5)) : null, located ? Number(lon.toFixed(5)) : null,
    clean(hospital.specialityCode), Number(hospital.stateCode) || 0, Number(hospital.districtCode) || 0,
    hospital.empaneledDate ? String(hospital.empaneledDate).slice(0, 10) : "",
  ];
}

const tiles = new Map();
const states = new Map();
let located = 0;
for (const hospital of hospitals) {
  const record = row(hospital);
  if (!states.has(record[8])) states.set(record[8], []);
  states.get(record[8]).push(record);
  if (record[5] === null) continue;
  located++;
  const key = `${Math.floor(record[5] / TILE_DEGREES)}_${Math.floor(record[6] / TILE_DEGREES)}`;
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(record);
}
for (const [key, records] of tiles) writeFileSync(join(outDir, "tiles", `${key}.json`), JSON.stringify(records));
for (const [code, records] of states) {
  records.sort((a, b) => a[1].localeCompare(b[1]));
  writeFileSync(join(outDir, "states", `${code}.json`), JSON.stringify(records));
}

const pinGroups = new Map();
for (const [pin, place] of Object.entries(pinIndex.pincodes)) {
  const prefix = pin.slice(0, 3);
  if (!pinGroups.has(prefix)) pinGroups.set(prefix, {});
  pinGroups.get(prefix)[pin] = [place.lat, place.lon, place.district, place.state];
}
for (const [prefix, pins] of pinGroups) writeFileSync(join(outDir, "pincodes", `${prefix}.json`), JSON.stringify(pins));

const meta = {
  snapshotDate: snapshot,
  fetchedFrom: manifest.source, fetchStartedAt: manifest.startedAt, fetchFinishedAt: manifest.finishedAt,
  hospitals: hospitals.length, locatedHospitals: located, nhaReportedTotal: manifest.nationalTotal,
  pincodes: Object.keys(pinIndex.pincodes).length, pincodeSources: pinIndex.sources, pincodesBuiltAt: pinIndex.builtAt,
  tileDegrees: TILE_DEGREES, builtAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
const changesFile = join(dataDir, "nha-hospitals", snapshot, "changes.json");
if (existsSync(changesFile)) writeFileSync(join(outDir, "changes.json"), readFileSync(changesFile));
console.log(`Snapshot ${snapshot}: ${hospitals.length} hospitals (${located} located) → ${tiles.size} tiles, ${states.size} states; ${meta.pincodes} PINs → ${pinGroups.size} files in ${outDir}`);
