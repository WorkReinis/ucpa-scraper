// End-to-end test of db + report using the real captured cards, no network.
import { CARDS } from "./src/fixture.mjs";
import { parseCard } from "./src/parse.mjs";
import { open, startRun, upsert, finishRun, upsertWeek } from "./src/db.mjs";

const db = open("ucpa.db");
const rows = CARDS.map(c => parseCard(c.href, c.text));

// run 1
let id = startRun(db, "fixture-run-1");
for (const r of rows) upsert(db, id, r);
finishRun(db, id, rows.length);

// run 2 with a couple of prices moved, to exercise v_delta
let id2 = startRun(db, "fixture-run-2");
for (const r of rows) {
  const m = { ...r };
  if (m.code === "sfavisn03") m.price = 790;
  if (m.code === "sfaslan07") m.price = 540;
  upsert(db, id2, m);
}
finishRun(db, id2, rows.length);

// A few upcoming weeks so /api/weeks, the Trip cost tab and
// src/flights.mjs all have rows to chew on without a live scrape. Dates are
// relative (Sat-to-Sat, a month-ish out) so the seed is always "upcoming"
// whenever it's run, unlike the fixed prices above.
const sat = (k) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (((6 - d.getUTCDay() + 7) % 7) || 7) + k * 7);
  return d.toISOString().slice(0, 10);
};
for (const [code, k, price, seats] of [
  ["sfavisn03", 4, 837, 5],
  ["sfavisn03", 5, 790, 2],
  ["sfaslan07", 4, 540, 8],
]) {
  upsertWeek(db, {
    code, start_date: sat(k), end_date: sat(k + 1),
    price, list_price: price, discount_pct: 0,
    status: "Départ garanti", seats_left: seats, booked: 3,
  });
}
console.log("seeded 2 runs + 3 weeks\n");
