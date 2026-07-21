// Canonical beginner -> expert gradation, based on the minimum experience
// required to join a package. UCPA describes difficulty in a different vocabulary per activity --
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
  // "Initié à expert" accepts UCPA's first post-beginner level, even though
  // the same package also splits more experienced guests into suitable groups.
  "Ski - initié à expert": "Novice",
  "Snowboard - Initié à expert": "Novice",
  // UCPA's on-piste ladder is Débutant < Initié < Confirmé < Maîtrise. Only
  // the two ends were visible while the scraper saw one listing page per
  // activity; the middle rungs appeared once the full catalogue was fetched.
  "Ski - Initié": "Novice",
  "Snowboard - Initié": "Novice",
  "Ski - Confirmé": "Intermediate",
  "Snowboard - Confirmé": "Intermediate",
  "Ski - Maîtrise": "Advanced",
  "Snowboard - Maîtrise": "Advanced",
  // Open-to-everyone packages (Biathlon, Raquettes): no minimum experience,
  // so they rank at the accessible end of the same "minimum entry" scale.
  "Tous niveaux": "Beginner",
  // "Découverte" means discovering off-piste, not learning to ski: UCPA
  // requires an already-confirmed piste skier or snowboarder.
  "Snowboard hors-piste - Découverte": "Intermediate",
  "Ski hors-piste - Découverte": "Intermediate",
  "Splitboard - R1": "Intermediate",
  "Ski de randonnée - Niveau 1": "Intermediate",
  "Snowboard hors-piste - All Mountain": "Advanced",
  "Ski hors-piste - All Mountain": "Advanced",
  "Splitboard - R2": "Advanced",
  "Ski de randonnée - Niveau 2": "Advanced",
  "Snowboard hors-piste - Expert": "Expert",
  "Ski hors-piste - Expert": "Expert",
  // Touring grades 3 and 4 both sit above Niveau 2; "Expert" is the top of
  // this scale, so they share it rather than inventing a rung above it.
  "Ski de randonnée - Niveau 3": "Expert",
  "Ski de randonnée - Niveau 4": "Expert",
  // Not skill levels -- UCPA's CMS leaks these two into the level field on a
  // handful of otherwise-normal, bookable packages ("dépublié" = unpublished,
  // "Déjà fait" = already done). Mapped to Unrated so the product still gets
  // catalogued instead of being dropped by productIssues() for an unknown
  // level, without pretending we know where it sits on the ladder.
  "Tous niveaux dépublié": "Unrated",
  "Déjà fait": "Unrated",
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
