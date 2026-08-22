import { ACTIVITIES } from "./parse.mjs";
import { KNOWN_REGIONS } from "./categories.mjs";
import { LEVEL_TIERS } from "./levels.mjs";

export const MAX_CATALOGUE_DROP_RATE = 0.15;
export const MAX_DETAIL_FAILURE_RATE = 0.10;
export const MAX_UNPARSEABLE_RATE = 0.02;
export const MIN_UNPARSEABLE_TOLERANCE = 2;

const KNOWN_ACTIVITIES = new Set([...ACTIVITIES, "Ski ou snowboard"]);

export function wholePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : null;
}

export function productIssues(row) {
  const issues = [];
  if (!/^[a-z0-9]+$/i.test(row.code ?? "")) issues.push("invalid product code");
  if (!/^https:\/\/www\.ucpa\.com\//.test(row.url ?? "")) issues.push("invalid UCPA URL");
  if (!row.title?.trim()) issues.push("missing title");
  if ((row.title?.length ?? 0) > 180) issues.push("suspiciously long title");
  if (!row.resort?.trim()) issues.push("missing resort");
  if (!row.region?.trim()) issues.push("missing region");
  if (!KNOWN_ACTIVITIES.has(row.activity)) issues.push(`unknown activity: ${row.activity ?? "null"}`);
  // A missing level (UCPA simply didn't return expertise_level) isn't a bad
  // scrape -- same as the leaked-string entries in LEVEL_TIERS, it's meant to
  // fall back to "Unrated" (src/levels.mjs tierOf()) rather than block the
  // product from being catalogued at all.
  if (row.level != null && !Object.hasOwn(LEVEL_TIERS, row.level)) issues.push(`unknown level: ${row.level}`);
  if (!KNOWN_REGIONS.includes(row.region)) issues.push(`unknown region: ${row.region ?? "null"}`);
  if (!Number.isInteger(row.price) || row.price <= 0) issues.push("invalid package price");
  if (row.list_price != null && (!Number.isInteger(row.list_price) || row.list_price <= 0)) {
    issues.push("invalid list price");
  }
  return issues;
}

export function toleratedUnparseableCount(candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return 0;
  return Math.max(
    MIN_UNPARSEABLE_TOLERANCE,
    Math.floor(candidateCount * MAX_UNPARSEABLE_RATE)
  );
}

export function sourceIssues({ count, previousCount, unparseableCount, candidateCount }) {
  const issues = [];
  if (count === 0) issues.push("no products returned");
  const tolerance = toleratedUnparseableCount(candidateCount);
  if (unparseableCount > tolerance) {
    issues.push(
      `${unparseableCount} product card(s) could not be parsed (tolerance ${tolerance})`
    );
  }
  if (previousCount > 0 && count < previousCount * (1 - MAX_CATALOGUE_DROP_RATE)) {
    const drop = Math.round((1 - count / previousCount) * 100);
    issues.push(`product count dropped ${drop}% (${previousCount} -> ${count})`);
  }
  return issues;
}

export function sourceWarnings({ unparseableCount, candidateCount }) {
  const tolerance = toleratedUnparseableCount(candidateCount);
  if (unparseableCount > 0 && unparseableCount <= tolerance) {
    return [
      `${unparseableCount} product card(s) quarantined within tolerance ${tolerance}`,
    ];
  }
  return [];
}

export function detailIssues(details) {
  const issues = [];
  if (!details.image_url) issues.push("missing image");
  if (!Array.isArray(details.includes) || details.includes.length === 0) issues.push("missing included items");
  if (!details.accommodation) issues.push("missing accommodation");
  return issues;
}

/** Shape check for one nested flight_quotes cell. A null cell has never been
 * quoted. A present cell with price null is also valid: the provider search
 * completed but no viable outbound/return pair was available. */
export function flightQuoteIssues(quote) {
  if (quote == null) return [];
  const issues = [];
  const pricingMode = quote.pricing_mode ?? "legacy";
  if (!["legacy", "roundtrip", "separate"].includes(pricingMode)) {
    issues.push(`invalid flight pricing mode: ${pricingMode}`);
  }
  const airportFields = [
    ["departure", quote.dep_airport],
    ["arrival", quote.arr_airport],
    ["return departure", quote.return_dep_airport],
    ["return arrival", quote.return_arr_airport],
  ];
  if (quote.price == null) {
    for (const [label, value] of airportFields) {
      if (value != null && !/^[A-Z]{3}$/.test(value)) issues.push(`invalid ${label} airport: ${value}`);
    }
    return issues;
  }
  if (!Number.isInteger(quote.price) || quote.price <= 0) issues.push(`invalid flight price: ${quote.price}`);
  if (pricingMode === "roundtrip" && (quote.price_outbound != null || quote.price_return != null)) {
    issues.push("round-trip fare must not contain additive one-way price halves");
  }
  if (pricingMode === "separate") {
    if (!Number.isInteger(quote.price_outbound) || !Number.isInteger(quote.price_return) ||
        quote.price_outbound + quote.price_return !== quote.price) {
      issues.push("separate-ticket fare must equal its two one-way prices");
    }
  }
  for (const [label, value] of airportFields.slice(0, 2)) {
    if (!/^[A-Z]{3}$/.test(value ?? "")) issues.push(`invalid ${label} airport: ${value}`);
  }
  if (quote.details_scope === "both") {
    for (const [label, value] of airportFields.slice(2)) {
      if (!/^[A-Z]{3}$/.test(value ?? "")) issues.push(`invalid ${label} airport: ${value}`);
    }
  }
  return issues;
}

export function assertDetailFailureRate(failed, total) {
  const rate = total === 0 ? 1 : failed / total;
  if (rate > MAX_DETAIL_FAILURE_RATE) {
    throw new Error(
      `strict scrape rejected ${failed}/${total} week/detail failures (${Math.round(rate * 100)}%)`
    );
  }
  return rate;
}
