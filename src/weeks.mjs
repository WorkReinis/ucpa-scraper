// Per-date price + availability, the thing the listing cards can't give you.
//
// Every product page embeds an AMP widget that hydrates from one JSON endpoint:
//   <amp-state id="reserve" src="/api/product/{internal_id}?agency=1-1-1&...">
// That JSON's `offersInfo` array *is* the full week calendar: one entry per
// (week, with/without transport), each with its own price and live stock. This
// is a plain GET, no auth, no cookies -- confirmed live against sfavisn03.
//
// The "Bouhhh... C'est complet !" text some product pages server-render is the
// widget's empty state before the fetch above fires, not a real sold-out flag.
// Ignore it; the JSON is authoritative.

import { writeDiagnostic } from "./diagnostics.mjs";

const RESERVE_SRC_RE = /<amp-state\s+id="reserve"\s+src="([^"]+)"/;

/** Pull the reserve-state API URL out of a product page's raw HTML. */
export function extractReserveUrl(html) {
  const m = html.match(RESERVE_SRC_RE);
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, "&");
  return src.startsWith("http") ? src : `https://www.ucpa.com${src}`;
}

/** "29/11/2026" -> "2026-11-29". Built from dF rather than the unix `date`
 *  field so there's no timezone rounding to get wrong. */
function isoFromDF(dF) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dF ?? "")) throw new Error(`invalid offer date: ${dF ?? "null"}`);
  const [dd, mm, yyyy] = dF.split("/");
  const iso = `${yyyy}-${mm}-${dd}`;
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    throw new Error(`invalid offer date: ${dF}`);
  }
  return iso;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * offersInfo -> one week row per date. Deliberately keeps every date,
 * including ones with available_stock 0 or vendable:false -- "this week just
 * sold out" is exactly the signal this tracker exists to catch, not noise to
 * filter.
 *
 * available_stock is already the *remaining* seat count, not total capacity:
 * the site's own "Plus que 2 places disponibles" warning fires exactly when
 * available_stock hits 2. booked_stock is separate (social-proof "N booked
 * so far"), kept alongside for reference.
 *
 * transInc:0 (hors transport) is the one canonical, comparable price per
 * date -- it's also what the listing cards quote. transInc:1 is NOT one
 * offer: UCPA fans it out per pickup city (idTrajet/departC -- "Paris Car",
 * "Clermont-Ferrand Car", a train option, etc), each a complete "package +
 * this city's transport" total, not a supplement -- so a naive key on
 * (date, transport_included) would silently collapse up to ~20
 * different-priced rows into one via last-write-wins. Those get parsed out
 * separately, below, into one row per (date, city).
 */
export function parseOffers(json, code) {
  if (!json || typeof json !== "object" || !Array.isArray(json.offersInfo)) {
    throw new Error("reserve response is missing offersInfo[]");
  }
  const offers = json.offersInfo;
  if (offers.length === 0) throw new Error("reserve response contains no offers");
  const byDate = new Map();

  const rowFor = (o, start) =>
    byDate.get(start) ?? {
      code,
      start_date: start,
      end_date: o.pN != null ? addDays(start, o.pN) : null,
      price: null,
      list_price: null,
      discount_pct: 0,
      status: null,
      seats_left: null,
      booked: null,
    };

  for (const o of offers) {
    if (o.transInc) continue; // handled below
    const start = isoFromDF(o.dF);
    const price = Number(o.price);
    const listPrice = o.prePrice == null ? null : Number(o.prePrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid offer price for ${o.dF}`);
    if (listPrice != null && (!Number.isFinite(listPrice) || listPrice <= 0)) {
      throw new Error(`invalid offer list price for ${o.dF}`);
    }
    if (o.pN != null && (!Number.isInteger(Number(o.pN)) || Number(o.pN) <= 0)) {
      throw new Error(`invalid offer duration for ${o.dF}`);
    }
    if (o.available_stock != null && (!Number.isInteger(Number(o.available_stock)) || Number(o.available_stock) < 0)) {
      throw new Error(`invalid available stock for ${o.dF}`);
    }
    byDate.set(start, {
      ...rowFor(o, start),
      price: Math.ceil(price),
      list_price: listPrice == null ? null : Math.ceil(listPrice),
      discount_pct: o.promo ?? 0,
      status: o.status?.message ?? null,
      seats_left: o.available_stock ?? null,
      booked: o.booked_stock ?? null,
    });
  }

  if (byDate.size === 0) throw new Error("reserve response contains no package-only offers");

  // Transport-inclusive offers are deliberately ignored. The app tracks the
  // package's comparable hors-transport price only; it does not model or
  // recommend UCPA pickup routes.
  return { weeks: [...byDate.values()] };
}

/**
 * Fetch a product page, follow it to the reserve-state API, return both the
 * week rows and the raw page HTML -- callers that also want
 * src/details.mjs's package-composition data can reuse that HTML instead of
 * fetching the same page twice.
 */
export async function fetchWeeks(code, productUrl, ua) {
  const html = await fetch(productUrl, {
    headers: { "user-agent": ua, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${productUrl}`);
    return r.text();
  });

  const reserveUrl = extractReserveUrl(html);
  if (!reserveUrl) {
    writeDiagnostic(`${code}-missing-reserve-state`, html, "html");
    throw new Error(`no reserve state on ${productUrl} -- page layout may have changed`);
  }

  const json = await fetch(reserveUrl, {
    headers: {
      "user-agent": ua,
      accept: "application/json",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      referer: productUrl,
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${reserveUrl}`);
    return r.json();
  });

  let weeks;
  try {
    ({ weeks } = parseOffers(json, code));
  } catch (error) {
    writeDiagnostic(`${code}-invalid-reserve-response`, json, "json");
    throw error;
  }
  return { html, weeks };
}
