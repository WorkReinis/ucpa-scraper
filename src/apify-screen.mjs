// node --env-file-if-exists=.env src/apify-screen.mjs            -> screen keys
// node --env-file-if-exists=.env src/apify-screen.mjs --schema    -> dump actor input schema
// node --env-file-if-exists=.env src/apify-screen.mjs --run       -> run actor on the fullest key
//
// Diagnostic CLI for the Apify Google Flights provider (src/providers/).
// Screens every APIFY_KEY_* for remaining free-tier credit, and can spend a
// little of the fullest account on one real search to measure cost and
// output quality. The pipeline itself lives in src/flights.mjs; this tool
// never touches the database.
//
// Tokens are never printed in full -- only the env var name and a masked tail.

import {
  collectKeys, inspectKey, pickFullest, pooledRemaining, mask,
} from "./providers/apify-keys.mjs";
import { ACTOR_ID, apifyApi, runApifyActor } from "./providers/apify.mjs";
import { ORIGIN_AIRPORTS, DEST_AIRPORTS } from "./airports.mjs";

// A real winter week inside Google's ~11-month booking horizon, matching the
// shape flights.mjs quotes.
const DEFAULT_OUTBOUND = "2026-12-19";
const DEFAULT_RETURN = "2026-12-27";

const usd = (n) => (n == null ? "  n/a" : `$${Number(n).toFixed(3)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(rows, totalKeys) {
  console.log("\nApify account screen");
  console.log("-".repeat(78));
  console.log(
    "key".padEnd(14) + "account".padEnd(22) +
    "limit".padStart(8) + "used".padStart(9) + "left".padStart(9) + "  cycle ends"
  );
  console.log("-".repeat(78));
  for (const r of rows) {
    const label = `${r.name} ${mask(r.token)}`;
    if (r.error) {
      console.log(label.padEnd(14) + `ERROR: ${r.error}`.slice(0, 62));
      continue;
    }
    console.log(
      label.padEnd(14) +
      String(r.username).slice(0, 20).padEnd(22) +
      usd(r.limitUsd).padStart(8) + usd(r.usedUsd).padStart(9) +
      usd(r.remainingUsd).padStart(9) +
      "  " + (r.cycleEnd ? r.cycleEnd.slice(0, 10) : "n/a")
    );
  }
  console.log("-".repeat(78));

  for (const r of rows) {
    if (r.aliases.length) {
      console.log(`!  ${r.name} and ${r.aliases.join(", ")} hold the SAME token -- one account, not ${r.aliases.length + 1}.`);
    }
  }
  const live = rows.filter((r) => !r.error);
  console.log(`\n${live.length} distinct account(s) from ${totalKeys} key entries; ${usd(pooledRemaining(rows))} pooled credit remaining.`);
  return live;
}

/** What flights.mjs actually needs: the cheapest itinerary and its shape. */
function assessOutput(items) {
  console.log(`\ndataset: ${items.length} item(s)`);
  if (!items.length) return;

  const first = items[0];
  console.log(`top-level keys: ${Object.keys(first).join(", ")}`);

  // The actor mirrors SerpApi's google_flights schema closely enough that
  // flights.mjs parseFlightResponse consumes it unchanged -- check.
  const itineraries = [
    ...(first.best_flights ?? []),
    ...(first.other_flights ?? []),
  ].filter((it) => it?.price != null);

  const flat = Array.isArray(first.all_flights) ? first.all_flights : [];
  console.log(
    `best_flights=${first.best_flights?.length ?? 0} ` +
    `other_flights=${first.other_flights?.length ?? 0} ` +
    `all_flights=${flat.length}`
  );
  console.log(`price_insights: ${JSON.stringify(first.price_insights ?? null)}`);

  if (!itineraries.length) {
    console.log("no priced itineraries in best_flights/other_flights -- inspect the raw item below");
    console.log(JSON.stringify(first, null, 2).slice(0, 2000));
    return;
  }

  const cheapest = itineraries.reduce((a, b) => (b.price < a.price ? b : a));
  const legs = cheapest.flights ?? cheapest.legs ?? [];
  console.log("\ncheapest itinerary:");
  console.log(`  price       ${cheapest.price}`);
  console.log(`  total_dur   ${cheapest.total_duration ?? "n/a"}`);
  console.log(`  legs        ${legs.length}`);
  for (const leg of legs) {
    const from = leg?.departure_airport?.id ?? leg?.departure_airport ?? "?";
    const to = leg?.arrival_airport?.id ?? leg?.arrival_airport ?? "?";
    console.log(`    ${from} -> ${to}  ${leg?.airline ?? "?"} ${leg?.flight_number ?? ""}`);
  }

  // Exactly the fields parseFlightResponse destructures today.
  const compatible = legs.length > 0 && legs.every((leg) =>
    leg?.departure_airport?.id && leg?.arrival_airport?.id && leg?.airline
  );
  console.log(
    `\nparseFlightResponse compatibility: ${compatible ? "OK -- leg shape matches SerpApi" : "MISMATCH -- adapter needed"}`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const { unique, total } = collectKeys();
  if (!unique.length) throw new Error("no APIFY_KEY_* found -- add them to .env");

  const rows = report(await Promise.all(unique.map((key) => inspectKey(key))), total);

  if (args.includes("--schema")) {
    const token = (pickFullest(rows) ?? rows[0]).token;
    const build = await apifyApi(`/acts/${ACTOR_ID}/builds/default`, token);
    const schema = build?.inputSchema;
    console.log("\nactor input schema:");
    console.log(typeof schema === "string" ? schema : JSON.stringify(schema, null, 2));
    return;
  }

  if (!args.includes("--run")) {
    console.log("\nPass --run to spend a little credit on one real search, or --schema to see the actor input fields.");
    return;
  }

  const chosen = pickFullest(rows);
  if (!chosen) throw new Error("no account has remaining credit");
  console.log(`\nusing ${chosen.name} (${chosen.username}) -- ${usd(chosen.remainingUsd)} left`);

  const argValue = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  const origins = argValue("--origins", ORIGIN_AIRPORTS.join(","));
  const dests = argValue("--dests", DEST_AIRPORTS.join(","));
  const combos = origins.split(",").length * dests.split(",").length;
  console.log(`route matrix: ${origins.split(",").length} origins x ${dests.split(",").length} dests = ${combos} combos`);

  const input = {
    departure_id: origins,
    arrival_id: dests,
    outbound_date: argValue("--outbound", DEFAULT_OUTBOUND),
    return_date: argValue("--return", DEFAULT_RETURN),
    currency: "EUR",
    hl: "en",
    // Each resolved booking URL bills as a separate event and one search
    // returns 80-120 of them. We only need the cheapest price. Keep this off.
    fetch_booking_options: false,
    max_pages: 1,
  };
  console.log(`\nactor input:\n${JSON.stringify(input, null, 2)}`);

  const before = chosen.remainingUsd;
  const { run, items } = await runApifyActor(chosen.token, input);
  console.log(`run finished: ${run.status}`);

  console.log("\ncost");
  console.log(`  usageTotalUsd  ${usd(run.usageTotalUsd)}`);
  console.log(`  computeUnits   ${run.stats?.computeUnits ?? "n/a"}`);
  console.log(`  runtime        ${run.stats?.runTimeSecs ?? "n/a"}s`);

  assessOutput(items);

  // usageTotalUsd only counts the actor's own charge; platform compute and
  // storage land separately and the limits endpoint lags by a few seconds.
  // The credit delta is the real bill, so wait for it to settle.
  let after = await inspectKey(chosen);
  for (let i = 0; i < 10 && after.remainingUsd === before; i++) {
    await sleep(3000);
    after = await inspectKey(chosen);
  }
  if (before != null && after.remainingUsd != null) {
    const billed = before - after.remainingUsd;
    console.log(`\ncredit on ${chosen.name}: ${usd(before)} -> ${usd(after.remainingUsd)}`);
    console.log(`  actually billed  ${usd(billed)}${billed === 0 ? " (not settled yet -- re-screen in a minute)" : ""}`);
    if (billed > 0) {
      console.log(`  per combo        ${usd(billed / combos)}`);
      console.log(`  40-pair season   ${usd(billed * 40)}`);
      console.log(`  runs left here   ~${Math.floor(after.remainingUsd / billed)}`);
    }
  }

  if (run.status !== "SUCCEEDED") {
    console.log(`\nrun did not succeed. Check https://console.apify.com/actors/runs/${run.id}`);
    process.exitCode = 1;
  }
}

await main();
