# Jan Sahayak data

Nightly copy of the National Health Authority (NHA) Ayushman Bharat PM-JAY empanelled hospital directory, plus a PIN code location index, published as static files for the Jan Sahayak site's "hospitals near my PIN" search.

Published data: `https://amithrh.github.io/jan-sahayak-data/data/meta.json`

This is an independent project, not a government service. A directory listing does not confirm that a hospital is accepting PM-JAY patients today or offers a particular treatment package. Confirm with the hospital's Ayushman desk or the PM-JAY helpline 14555.

## Published files

| Path under `/data` | Contents |
| --- | --- |
| `meta.json` | Snapshot date, hospital counts, NHA's reported total, sources |
| `changes.json` | Hospitals added, removed or changed since the previous snapshot (after the second run) |
| `pincodes/<first 3 digits>.json` | `{ "560098": [lat, lon, district, state] }` |
| `tiles/<row>_<col>.json` | Hospitals with a map location in a 0.5° cell (`row = floor(lat / 0.5)`) |
| `states/<NHA state code>.json` | Every hospital in a state |

Hospital rows are arrays: `[facilityId, name, address, phone, type (G/P), lat, lon, specialityCodes, stateCode, districtCode, empanelledOn]`. `lat`/`lon` are `null` when NHA has no usable location.

## Nightly refresh

NHA refuses requests from GitHub Actions and Cloudflare (HTTP 403), so the refresh runs on a machine in India that NHA accepts. `scripts/nightly-refresh.sh`:

1. `scripts/sync-nha-hospitals.mjs` copies the NHA HEM directory state by state (about 4,000 requests at a polite rate, 35–70 minutes) and checks each state's count against NHA's own total.
2. `scripts/build-site-data.mjs` builds the files above. It refuses to publish a snapshot with an incomplete state or with more than 5% fewer hospitals than the previous one.
3. The files are force-pushed as a single commit to the `gh-pages` branch, which GitHub Pages serves. If any step fails, Pages keeps the previous day's data.

The last two snapshots stay in `.data/nha-hospitals` so each run can report changes. NHA lists some hospitals twice; unique hospitals (39,568 on 27 September 2026) are fewer than NHA's reported total (40,204).

On macOS the script is scheduled by a launchd agent at 02:00 local time (`~/Library/LaunchAgents/com.amitmishra.jan-sahayak-refresh.plist`), wrapped in `caffeinate -i` so the Mac does not sleep mid-run. If the Mac is asleep at 02:00, launchd runs the job when it wakes; if it is shut down, that night is skipped. Logs: `~/Library/Logs/jan-sahayak-refresh.log`. On a Linux server, a cron entry such as `30 2 * * * /path/to/jan-sahayak-data/scripts/nightly-refresh.sh >> refresh.log 2>&1` does the same.

## PIN code locations

`data/pincodes.json` is committed and rebuilt only when the sources change:

```bash
node scripts/build-pincode-index.mjs
```

It reads `sources/indiapost-pincode.csv` (India Post "All India Pincode directory with latitude and longitude", data.gov.in Open Government Data; copy at github.com/dropdevrahul/pincodes-india) and `sources/IN.txt` ([GeoNames postal codes](https://download.geonames.org/export/zip/), CC-BY 4.0) for the few PINs without India Post coordinates. Sources are not committed. India Post geocodes are sometimes wrong in groups, so each PIN uses the largest cluster of its post offices that lies inside its district. Against 1,766 hospitals whose NHA address contains a PIN, the median distance from that PIN's point is 2.3 km; 70% are within 5 km.

## Local use

```bash
scripts/nightly-refresh.sh               # full refresh and publish
node scripts/sync-nha-hospitals.mjs      # writes .data/nha-hospitals/<date>/
node scripts/build-site-data.mjs         # writes .pages/data/
node scripts/nearby-hospitals.mjs 560098 --radius 5 --type G
```

Node 22 or later; no dependencies.

## Attribution

Hospital data: National Health Authority, Hospital Engagement Module (hem.nha.gov.in). PIN locations: India Post via data.gov.in (Government Open Data License – India) and GeoNames (CC-BY 4.0).
