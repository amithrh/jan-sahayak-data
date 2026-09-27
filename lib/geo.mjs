// Great-circle distance between two { latitude, longitude } points.
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Hospitals nearest to a PIN, using the PIN's point and each hospital's NHA coordinates.
// `pincodes` is the `pincodes` map from pincodes.json; `hospitals` are NHA records.
export function hospitalsNearPin(pin, pincodes, hospitals, { radiusKm = 15, limit = 20, type } = {}) {
  const place = pincodes[pin];
  if (!place) return null;
  const origin = { latitude: place.lat, longitude: place.lon };
  const results = [];
  for (const hospital of hospitals) {
    if (type && hospital.hospTypeCode !== type) continue;
    const latitude = Number(hospital.hospLatitude), longitude = Number(hospital.hospLongitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (!latitude && !longitude)) continue;
    const km = distanceKm(origin, { latitude, longitude });
    if (km <= radiusKm) results.push({ hospital, km });
  }
  results.sort((a, b) => a.km - b.km);
  return { pin, place, total: results.length, results: results.slice(0, limit) };
}
