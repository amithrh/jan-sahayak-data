// Builds one point per Indian PIN code.
//   node scripts/build-pincode-index.mjs [--indiapost sources/indiapost-pincode.csv] [--geonames sources/IN.txt] [--out data/pincodes.json]
// Primary source: India Post's "All India Pincode directory with latitude and longitude"
// (data.gov.in OGD release; mirrored at github.com/dropdevrahul/pincodes-india). GeoNames
// (CC-BY 4.0) fills PINs India Post leaves without coordinates, but only where GeoNames
// geocoded a named place: its "estimated" rows are district placeholders tens of km off.
// Each PIN's point is the median of one cluster of its offices: the largest cluster that lies
// inside the PIN's district, which discards mis-geocoded offices.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { distanceKm } from "../lib/geo.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const dataDir = new URL("../sources/", import.meta.url).pathname;
const indiaPostFile = resolve(args.indiapost ?? `${dataDir}indiapost-pincode.csv`);
const geonamesFile = resolve(args.geonames ?? `${dataDir}IN.txt`);
const output = resolve(args.out ?? new URL("../data/pincodes.json", import.meta.url).pathname);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// India's bounding box; anything outside is a bad geocode.
const inIndia = (latitude, longitude) => latitude > 6 && latitude < 37.5 && longitude > 68 && longitude < 97.5;
const titleCase = (value) => value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

function parseCsvLine(line) {
  const cells = [];
  let cell = "", quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

const offices = new Map();
const names = new Map();
const add = (pin, row) => {
  if (!offices.has(pin)) offices.set(pin, []);
  offices.get(pin).push(row);
};

const [header, ...indiaPostLines] = readFileSync(indiaPostFile, "utf8").split(/\r?\n/);
const column = Object.fromEntries(parseCsvLine(header).map((name, index) => [name, index]));
for (const line of indiaPostLines) {
  if (!line) continue;
  const cells = parseCsvLine(line);
  const pin = cells[column.Pincode];
  if (!/^\d{6}$/.test(pin ?? "")) continue;
  if (!names.has(pin)) names.set(pin, { district: titleCase(cells[column.District]), state: titleCase(cells[column.StateName]) });
  const latitude = Number(cells[column.Latitude]), longitude = Number(cells[column.Longitude]);
  if (inIndia(latitude, longitude)) add(pin, { latitude, longitude, source: "indiapost" });
}

let geonamesFilled = 0;
const geonames = new Map();
for (const line of readFileSync(geonamesFile, "utf8").split("\n")) {
  const [, pin, , state, , district, , , , lat, lon, accuracy] = line.split("\t");
  const latitude = Number(lat), longitude = Number(lon);
  if (!/^\d{6}$/.test(pin ?? "") || Number(accuracy) < 3 || !inIndia(latitude, longitude)) continue;
  if (!names.has(pin)) names.set(pin, { district, state });
  if (!geonames.has(pin)) geonames.set(pin, []);
  geonames.get(pin).push({ latitude, longitude, source: "geonames" });
}
for (const [pin, rows] of geonames) if (!offices.has(pin)) { offices.set(pin, rows); geonamesFilled++; }

const centreOf = (rows) => ({ latitude: median(rows.map((row) => row.latitude)), longitude: median(rows.map((row) => row.longitude)) });

// India Post geocodes can be wrong in bulk: 9 of 13 offices in Kolkata's 700001 sit in one
// cluster 28 km away. A district's centre, taken over thousands of offices, is robust to
// that, so it arbitrates between a PIN's clusters.
const districtRows = new Map();
for (const [pin, rows] of offices) {
  const key = `${names.get(pin)?.state}|${names.get(pin)?.district}`;
  if (!districtRows.has(key)) districtRows.set(key, []);
  districtRows.get(key).push(...rows);
}
const districts = new Map([...districtRows].map(([key, rows]) => {
  const centre = centreOf(rows);
  const distances = rows.map((row) => distanceKm(centre, row)).sort((a, b) => a - b);
  // 80th percentile distance: how far a genuine office in this district usually lies.
  return [key, { centre, radiusKm: Math.max(10, distances[Math.floor(distances.length * 0.8)]) }];
}));

// Greedy clustering: each office joins the first cluster whose seed is within 8 km.
function clusters(rows) {
  const groups = [];
  for (const row of rows) {
    const group = groups.find((candidate) => distanceKm(candidate[0], row) <= 8);
    if (group) group.push(row); else groups.push([row]);
  }
  return groups.sort((a, b) => b.length - a.length);
}

const pincodes = {};
let trimmed = 0, rerouted = 0;
for (const [pin, rows] of offices) {
  const district = districts.get(`${names.get(pin)?.state}|${names.get(pin)?.district}`);
  const groups = clusters(rows);
  const inDistrict = district ? groups.filter((group) => distanceKm(district.centre, centreOf(group)) <= district.radiusKm) : [];
  const chosen = inDistrict[0] ?? groups[0];
  if (chosen !== groups[0]) rerouted++;
  trimmed += rows.length - chosen.length;
  const { latitude, longitude } = centreOf(chosen);
  // Radius covering the chosen offices tells the UI how approximate the point is.
  const spreadKm = Math.max(0, ...chosen.map((row) => distanceKm({ latitude, longitude }, row)));
  pincodes[pin] = {
    lat: Number(latitude.toFixed(4)), lon: Number(longitude.toFixed(4)),
    district: names.get(pin)?.district ?? "", state: names.get(pin)?.state ?? "",
    offices: chosen.length, spreadKm: Number(spreadKm.toFixed(1)), source: chosen[0].source,
    // Offices more than 8 km from the chosen cluster: a wide rural PIN or bad geocodes.
    otherOffices: rows.length - chosen.length,
  };
}

writeFileSync(output, JSON.stringify({
  sources: {
    indiapost: "India Post All India Pincode directory with latitude and longitude (data.gov.in OGD)",
    geonames: "GeoNames postal codes (https://download.geonames.org/export/zip/), CC-BY 4.0; fills PINs without India Post coordinates",
  },
  builtAt: new Date().toISOString(), count: Object.keys(pincodes).length, pincodes,
}));
const missing = [...names.keys()].filter((pin) => !pincodes[pin]);
console.log(`${Object.keys(pincodes).length} PIN codes → ${output} (${geonamesFilled} from GeoNames, ${trimmed} offices outside the chosen clusters, ${rerouted} PINs moved to their district cluster, ${missing.length} known PINs without coordinates)`);
