// node src/report.mjs           -> filtered catalogue, cheapest all-in first
// node src/report.mjs --moves   -> what changed since the last run
// node src/report.mjs --raw     -> ignore filters, dump everything

import { open } from "./db.mjs";

// ===========================================================================
// YOUR FILTERS -- edit this block, it is the whole point of the exercise
// ===========================================================================
const ME = {
  age: 33,                     // <- set this. It silently disqualifies a lot.
  maxPriceAllIn: 1400,         // package + travel, EUR
  minDays: 6,
  excludeBeginner: true,       // you're past "Débutant" runs
  // Resorts you'd actually go to. Empty array = no restriction.
  resorts: [],
  // Resorts you won't (bad transfer, too low, whatever).
  excludeResorts: [],
};

// Every UCPA price is "hors transport". A package tracker that ignores that is
// a rankings generator, not a decision tool -- Saint-Lary at 499 EUR and Val
// d'Isere at 837 EUR are much closer than they look once you add the Pyrenees
// transfer from Den Haag. Fill these in from real quotes and the ordering below
// starts telling the truth.
//
// site_code is chars 4-6 of the product code (sfa|VIS|n03 = Val d'Isere).
const TRAVEL_FROM_NL = {
  vis: 260, // Val d'Isere    -- rail to Bourg-St-Maurice + Altibus
  vth: 260, // Val Thorens
  arc: 250, // Les Arcs       -- funicular from Bourg, easiest transfer of the lot
  sla: 420, // Saint-Lary     -- Pyrenees, effectively a fly-only trip
  cha: 230, // Chamonix       -- Geneva + transfer
  arg: 230, // Argentiere
  ser: 280, // Serre Chevalier
  d2a: 270, // Les Deux Alpes
  fla: 240, // Flaine
  DEFAULT: 300,
};

const travelFor = (site) => TRAVEL_FROM_NL[site] ?? TRAVEL_FROM_NL.DEFAULT;

// ===========================================================================

const db = open();
const raw = process.argv.includes("--raw");

if (process.argv.includes("--moves")) {
  const moves = db.prepare("SELECT * FROM v_delta ORDER BY delta_eur ASC").all();
  if (!moves.length) {
    console.log("No price changes. (Need at least two runs to compare.)");
  } else {
    console.table(
      moves.map((m) => ({
        code: m.code, resort: m.resort, title: m.title.slice(0, 34),
        was: m.price_prev, now: m.price_now,
        move: (m.delta_eur > 0 ? "+" : "") + m.delta_eur,
      }))
    );
  }
  process.exit(0);
}

let rows = db.prepare("SELECT * FROM v_current").all();
const before = rows.length;

if (!raw) {
  rows = rows.filter((r) => {
    // "Ski ou snowboard Pack Mini" is filed under activity=Ski alpin but takes
    // boarders. Filtering on the activity column alone loses it.
    const isBoard = /snowboard|splitboard/i.test(`${r.activity} ${r.title}`);
    if (!isBoard) return false;

    if (r.age_min != null && ME.age < r.age_min) return false;
    if (r.age_max != null && ME.age > r.age_max) return false;
    if (ME.excludeBeginner && /débutant/i.test(r.level || "")) return false;
    if (ME.minDays && r.days < ME.minDays) return false;
    if (ME.resorts.length && !ME.resorts.includes(r.resort)) return false;
    if (ME.excludeResorts.includes(r.resort)) return false;

    const allIn = r.price + travelFor(r.site_code);
    if (ME.maxPriceAllIn && allIn > ME.maxPriceAllIn) return false;
    return true;
  });
}

const out = rows
  .map((r) => ({
    code: r.code,
    resort: r.resort,
    title: r.title.slice(0, 32),
    lvl: (r.level || "").replace(/^(Snow|Ski)board? - /i, "").slice(0, 14),
    age: `${r.age_min}-${r.age_max}`,
    list: r.list_price,
    pkg: r.price,
    off: r.discount_pct ? `-${r.discount_pct}%` : "",
    travel: travelFor(r.site_code),
    allIn: Math.round(r.price + travelFor(r.site_code)),
    from: r.first_week,
  }))
  .sort((a, b) => a.allIn - b.allIn);

console.log(
  raw
    ? `all ${out.length} products`
    : `${out.length} of ${before} products match (age ${ME.age}, all-in <= ${ME.maxPriceAllIn} EUR)`
);
console.table(out);

const ageBlocked = db
  .prepare("SELECT COUNT(*) n FROM v_current WHERE age_max < ? AND discount_pct >= 30")
  .get(ME.age).n;
if (!raw && ageBlocked) {
  console.log(
    `\nNote: ${ageBlocked} product(s) with a 30%+ discount are age-capped below ${ME.age}. ` +
    `UCPA's loudest deals ("Happy Winter") are 18-25 only.`
  );
}
