// Canonical beginner -> expert gradation, layered on top of UCPA's own level
// labels. UCPA describes difficulty in a different vocabulary per activity --
// piste ability for Ski/Snowboard ("Débutant" .. "Initié à expert"), off-piste
// terrain grading for hors-piste ("Découverte" / "All Mountain" / "Expert"),
// and ski-touring difficulty for Splitboard ("R1" / "R2") -- none of which
// share enough vocabulary to be parsed into a common scale. (That's what the
// old tierOf() in server.mjs tried, by string-splitting the translated label
// -- it produced a display order, not a real ranking: nothing in the text
// says whether "R1" is easier or harder than "Discovery".)
//
// So this is a hand-assigned lookup, keyed on the exact raw (French) `level`
// string as stored in product.level, not a parser. Cross-activity ranks here
// are necessarily approximate -- off-piste terrain grade, touring difficulty,
// and on-piste teaching level aren't really the same axis of "hard". Treat
// this as "roughly comparable commitment/skill", not an exact equivalence,
// and revisit by hand if it ever has to carry more weight than sort order.
//
// New level strings UCPA introduces won't be in this table -- that's
// expected, not a bug. findUnknownCategories() (src/categories.mjs) flags
// them at scrape time so they get a real entry here instead of silently
// guessing. Until then they fall back to "Unrated".

export const TIER_ORDER = ["Beginner", "Novice", "Intermediate", "Advanced", "Expert", "Unrated"];

export const LEVEL_TIERS = {
  "Snowboard - Débutant": "Beginner",
  "Ski - Débutant": "Beginner",
  "Snowboard hors-piste - Découverte": "Novice",
  "Ski hors-piste - Découverte": "Novice",
  "Ski - initié à expert": "Intermediate",
  "Snowboard - Initié à expert": "Intermediate",
  "Splitboard - R1": "Intermediate",
  "Ski de randonnée - Niveau 1": "Intermediate",
  "Snowboard hors-piste - All Mountain": "Advanced",
  "Ski hors-piste - All Mountain": "Advanced",
  "Splitboard - R2": "Advanced",
  "Ski de randonnée - Niveau 2": "Advanced",
  "Snowboard hors-piste - Expert": "Expert",
  "Ski hors-piste - Expert": "Expert",
};

const UNRATED = "Unrated";

/** Raw (untranslated) `level` string -> canonical tier label. Unknown/new
 *  strings fall back to "Unrated" rather than a guessed tier. */
export function tierOf(rawLevel) {
  return LEVEL_TIERS[rawLevel] ?? UNRATED;
}

export function tierRank(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
}
