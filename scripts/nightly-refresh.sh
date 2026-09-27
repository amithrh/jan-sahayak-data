#!/bin/bash
# Nightly refresh, run on a machine NHA accepts requests from (NHA answers GitHub Actions
# and Cloudflare with HTTP 403). Copies the NHA directory, builds the site files, and
# publishes them as a single commit on the gh-pages branch, which GitHub Pages serves.
# Any failure stops before publishing, so Pages keeps the previous day's data.
#   scripts/nightly-refresh.sh            (scheduled by launchd; see README)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOCK="$ROOT/.data/nightly.lock"
mkdir -p "$ROOT/.data"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') Another refresh is running ($LOCK); exiting."
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

echo "$(date '+%F %T') Refresh starting"
git pull --ff-only --quiet origin main

node scripts/sync-nha-hospitals.mjs --out .data/nha-hospitals

# Keep the last two snapshots (for changes.json and the 5% drop check); per-state
# checkpoint files are only needed while a snapshot is being copied.
cd .data/nha-hospitals
snapshots=( $(ls -d 20??-??-?? | sort) )
for ((i = 0; i < ${#snapshots[@]} - 2; i++)); do rm -rf "${snapshots[$i]}"; done
for dir in 20??-??-??; do rm -rf "$dir/states"; done
cd "$ROOT"

node scripts/build-site-data.mjs --data .data --out .pages/data
touch .pages/.nojekyll

remote="$(git remote get-url origin)"
publish="$(mktemp -d)"
cp -R .pages/. "$publish/"
cd "$publish"
git init --quiet -b gh-pages
git add -A
snapshot="$(node -p 'require("./data/meta.json").snapshotDate')"
git -c user.name="Jan Sahayak refresh" -c user.email="noreply@github.com" commit --quiet -m "NHA directory $snapshot"
# One commit per publish keeps the repository small; history lives in changes.json.
git push --quiet --force "$remote" gh-pages
cd "$ROOT"
rm -rf "$publish"

node -e '
  const m = require("./.pages/data/meta.json");
  let c = null; try { c = require("./.pages/data/changes.json"); } catch {}
  console.log(`${new Date().toISOString()} Published ${m.snapshotDate}: ${m.hospitals} hospitals (${m.locatedHospitals} located)` +
    (c ? `; since ${c.comparedWith}: +${c.added.length} -${c.removed.length} ~${c.changed.length}` : ""));
'
