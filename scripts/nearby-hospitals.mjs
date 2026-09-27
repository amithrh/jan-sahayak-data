// Nearest empanelled hospitals to a PIN, from the local NHA copy and PIN index.
//   node scripts/nearby-hospitals.mjs 560098 [--radius 10] [--limit 10] [--type G|P]
import { readdirSync, readFileSync } from "node:fs";
import { hospitalsNearPin } from "../lib/geo.mjs";

const [pin, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (!/^\d{6}$/.test(pin ?? "")) {
  console.error("Usage: node scripts/nearby-hospitals.mjs <six-digit PIN> [--radius km] [--limit n] [--type G|P]");
  process.exit(1);
}

const root = new URL("../", import.meta.url).pathname;
const snapshot = readdirSync(`${root}.data/nha-hospitals`).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().pop();
const hospitals = JSON.parse(readFileSync(`${root}.data/nha-hospitals/${snapshot}/hospitals.json`, "utf8"));
const { pincodes } = JSON.parse(readFileSync(`${root}data/pincodes.json`, "utf8"));

const result = hospitalsNearPin(pin, pincodes, hospitals, {
  radiusKm: Number(options.radius ?? 10), limit: Number(options.limit ?? 10), type: options.type,
});
if (!result) {
  console.log(`PIN ${pin} is not in the PIN index.`);
  process.exit(1);
}
console.log(`PIN ${pin} · ${result.place.district}, ${result.place.state} · NHA directory as of ${snapshot}`);
const shown = result.results.length < result.total ? ` · showing nearest ${result.results.length} (--limit to see more)` : "";
console.log(`${result.total} empanelled hospitals within ${options.radius ?? 10} km (straight-line distance)${shown}\n`);
for (const { hospital, km } of result.results) {
  console.log(`${km.toFixed(1).padStart(5)} km  ${hospital.hospTypeCode === "G" ? "Govt" : "Pvt "}  ${hospital.hospName.trim()}`);
  console.log(`          ${hospital.hospAddress?.trim() ?? ""}${/\d{6,}/.test(hospital.hospContactNumber ?? "") ? ` · ${hospital.hospContactNumber}` : ""}`);
}
