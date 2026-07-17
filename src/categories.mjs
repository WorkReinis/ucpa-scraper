// Closed-vocabulary product columns UCPA could silently extend. A new
// activity or region shows up in the DB the moment UCPA adds one, but
// nothing else in this codebase knows about it until a human does:
// parse.mjs's ACTIVITIES whitelist won't detect it (silently leaves
// activity/level null on that card), translate.mjs won't translate it (falls
// through untouched, mixing French into otherwise-English UI text), and
// levels.mjs won't rank it (falls back to "Unrated"). None of those failures
// throw, so nothing forces anyone to notice.
//
// findUnknownCategories() is the one check that surfaces all of them. Run it
// after every scrape (src/scrape.mjs, printed as a warning) and expose it via
// /api/filters too (so it's visible in the browser, not just the scrape
// console) -- it diffs what's actually in the DB against what each module
// above already has a rule for. Add an entry to KNOWN below if another
// column needs the same watch.

import { ACTIVITIES } from "./parse.mjs";
import { LEVEL_TIERS } from "./levels.mjs";

// Mirrors translate.mjs's region rules (CATEGORICAL_RULES) -- kept as its own
// list rather than imported, since translate.mjs is a substitution table with
// no notion of "known" vs "unknown" values.
const KNOWN_REGIONS = ["Alpes du Nord", "Alpes du Sud", "Pyrénées", "Vallée du Mont Blanc"];

const KNOWN = {
  activity: new Set([...ACTIVITIES, "Ski ou snowboard"]), // retagged dual-discipline packages, see parse.mjs
  level: new Set(Object.keys(LEVEL_TIERS)),
  region: new Set(KNOWN_REGIONS),
};

/** { activity: [...], level: [...], region: [...] } of raw DB values none of
 *  activity/level/region handling knows about yet -- keys omitted when clean. */
export function findUnknownCategories(db) {
  const out = {};
  for (const [col, known] of Object.entries(KNOWN)) {
    const values = db
      .prepare(`SELECT DISTINCT ${col} v FROM product WHERE ${col} IS NOT NULL`)
      .all()
      .map((r) => r.v);
    const unknown = values.filter((v) => !known.has(v));
    if (unknown.length) out[col] = unknown;
  }
  return out;
}
