// Reverse geocoding: turns a vehicle's lat/lon into a human address via Nominatim
// (OpenStreetMap's free reverse geocoder) — brief's §3 substitute for Tessie's own
// undisclosed paid provider. Nominatim's usage policy caps at 1 req/sec and requires
// an identifying User-Agent (no API key); both are enforced here so the server module
// never has to think about it.
//
// Never throws: address is best-effort decoration on a state/location response, never
// load-bearing, so a bad network or a malformed body just means "no address this time."

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "freetessie/0.1 (self-hosted Tessie replacement, personal use)";
// Nominatim's own policy says "no more than 1 request per second" — padded past exactly
// 1000ms so two calls back-to-back never land inside the same second on a slow clock.
const MIN_INTERVAL_MS = 1100;

// Keyed on 4-decimal-rounded coords (~11m precision) so repeat reads of a parked car
// don't re-hit Nominatim at all. Only ever holds successful lookups — see below.
const cache = new Map<string, string | null>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single mutex chain, not a "read the clock, then sleep" check — two calls arriving
// close together must queue strictly one after another, not both compute the same wait
// against a lastCallAt that neither has updated yet.
let lastCallAt = 0;
let gate: Promise<void> = Promise.resolve();

async function waitForSlot(): Promise<void> {
  const previous = gate;
  let release = (): void => {};
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const waitMs = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (waitMs > 0) await sleep(waitMs);
  lastCallAt = Date.now();
  release();
}

export async function reverseGeocode(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    await waitForSlot();
    const url =
      `${NOMINATIM_URL}?format=jsonv2&lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lon)}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    // A transient failure isn't cached — a real address might be available on the very
    // next call, and caching "null" here would poison this spot for the process's life.
    if (!res.ok) return null;
    const body = (await res.json()) as { display_name?: unknown };
    const address = typeof body.display_name === "string" ? body.display_name : null;
    cache.set(key, address);
    return address;
  } catch {
    return null;
  }
}
