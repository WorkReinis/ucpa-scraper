// UCPA's own activity taxonomy is finer than anyone filtering by it wants:
// separate "Ski alpin" / "Ski hors-piste" / "Ski de randonnée" labels, plus a
// synthetic "Ski ou snowboard" tag parse.mjs adds for its own dual-discipline
// "Pack Mini" packages -- that one isn't really its own activity, it's a
// snowboard package AND a ski package shown as a single card. Filtering
// should work by discipline (ski / snowboard / splitboard / off-piste
// snowboard), not by which of UCPA's marketing labels a given package
// happens to carry -- so this groups the raw `activity` column into that
// smaller set of canonical buckets, with dual-discipline packages counted
// under both Ski and Snowboard.
//
// Multi-activités Montagne / Raquettes / Biathlon aren't ski, snowboard, or
// splitboard disciplines at all -- they aren't grouped, and fall through to
// their own (translated) bucket unchanged.

import { translate } from "./translate.mjs";

const GROUPS = {
  Ski: ["Ski alpin", "Ski ou snowboard"],
  "Off-piste ski": ["Ski hors-piste"],
  "Ski touring": ["Ski de randonnée"],
  Snowboard: ["Snowboard", "Ski ou snowboard"],
  Splitboard: ["Splitboard"],
  "Off-piste snowboard": ["Snowboard hors-piste"],
};

// Sidelines, not disciplines anyone is planning a week around: adaptive ski,
// biathlon, snowshoeing, and splitboard together account for 24 of ~1900
// bookable listings. They stay in the database -- the scrape still records
// them, and their price history keeps accumulating -- but src/catalog.mjs
// keeps them out of everything the app reads, so they don't pad the activity
// filter or the counts beside it.
//
// This costs nothing on the flight side. Quotes are keyed by
// (date pair x airport gateway) and shared by every package at that resort,
// and all 14 cells these touch are already covered by mainstream packages at
// the same resorts and dates -- so none of them pulls an airport search that
// wouldn't happen anyway.
export const HIDDEN_ACTIVITIES = [
  "Handiski (dual/tandem)",
  "Biathlon",
  "Raquettes",
  "Splitboard",
];

const DISPLAY_ORDER = Object.keys(GROUPS);
function rank(name) {
  const i = DISPLAY_ORDER.indexOf(name);
  return i === -1 ? DISPLAY_ORDER.length : i;
}

/** Raw (French) `activity` value -> the canonical bucket name(s) it belongs
 *  to. Almost always one, two for UCPA's dual-discipline packages; anything
 *  ungrouped falls back to its own translated name as a single-member bucket. */
export function groupsOf(rawActivity) {
  const groups = Object.entries(GROUPS)
    .filter(([, members]) => members.includes(rawActivity))
    .map(([name]) => name);
  return groups.length ? groups : [translate(rawActivity)];
}

/** Every canonical bucket name actually present across `rawValues`, deduped
 *  and ordered by the primary ski/snowboard disciplines first. */
export function groupsPresent(rawValues) {
  return [...new Set(rawValues.flatMap(groupsOf))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
