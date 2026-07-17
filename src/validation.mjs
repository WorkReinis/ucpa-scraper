import { ACTIVITIES } from "./parse.mjs";
import { KNOWN_REGIONS } from "./categories.mjs";
import { LEVEL_TIERS } from "./levels.mjs";

export const MAX_CATALOGUE_DROP_RATE = 0.15;
export const MAX_DETAIL_FAILURE_RATE = 0.10;

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
  if (!Object.hasOwn(LEVEL_TIERS, row.level)) issues.push(`unknown level: ${row.level ?? "null"}`);
  if (!KNOWN_REGIONS.includes(row.region)) issues.push(`unknown region: ${row.region ?? "null"}`);
  if (!Number.isInteger(row.price) || row.price <= 0) issues.push("invalid package price");
  if (row.list_price != null && (!Number.isInteger(row.list_price) || row.list_price <= 0)) {
    issues.push("invalid list price");
  }
  return issues;
}

export function sourceIssues({ count, previousCount, unparseableCount }) {
  const issues = [];
  if (count === 0) issues.push("no products returned");
  if (unparseableCount > 0) issues.push(`${unparseableCount} product card(s) could not be parsed`);
  if (previousCount > 0 && count < previousCount * (1 - MAX_CATALOGUE_DROP_RATE)) {
    const drop = Math.round((1 - count / previousCount) * 100);
    issues.push(`product count dropped ${drop}% (${previousCount} -> ${count})`);
  }
  return issues;
}

export function detailIssues(details) {
  const issues = [];
  if (!details.image_url) issues.push("missing image");
  if (!Array.isArray(details.includes) || details.includes.length === 0) issues.push("missing included items");
  if (!details.accommodation) issues.push("missing accommodation");
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
