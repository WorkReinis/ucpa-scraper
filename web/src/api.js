import { filterCatalog } from "./staticCatalog";

const BASE = "/api";
const STATIC_DATA = import.meta.env.VITE_STATIC_DATA === "1";
const STATIC_BASE = `${import.meta.env.BASE_URL}data`;
let staticCatalogPromise;
let staticFiltersPromise;

function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    // false is a real, meaningful "not set" for checkbox filters.
    // -- skip it like the other empty values, and stringify true as "1" to
    // match what the server actually checks for (src/server.mjs). Without
    // this, URLSearchParams.set() stringifies a JS `true` as the literal
    // text "true", which the server's `=== "1"` check silently never matches.
    if (v == null || v === "" || v === false || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) v.forEach((x) => s.append(k, x));
    else s.set(k, v === true ? "1" : v);
  }
  return s.toString();
}

export async function getFilters() {
  if (STATIC_DATA) {
    staticFiltersPromise ??= fetch(`${STATIC_BASE}/filters.json`).then((res) => {
      if (!res.ok) throw new Error(`GET static filters -> ${res.status}`);
      return res.json();
    });
    return staticFiltersPromise;
  }
  const res = await fetch(`${BASE}/filters`);
  if (!res.ok) throw new Error(`GET /filters -> ${res.status}`);
  return res.json();
}

export async function getWeeks(filters) {
  if (STATIC_DATA) {
    staticCatalogPromise ??= fetch(`${STATIC_BASE}/catalog.json`).then((res) => {
      if (!res.ok) throw new Error(`GET static catalog -> ${res.status}`);
      return res.json();
    });
    return filterCatalog(await staticCatalogPromise, filters);
  }
  const res = await fetch(`${BASE}/weeks?${qs(filters)}`);
  if (!res.ok) throw new Error(`GET /weeks -> ${res.status}`);
  return res.json();
}
