# Handoff: flight-quote feature (shuttle windows, one-way pricing, providers)

Written for an independent reviewer (Codex) to verify this work from scratch.
Everything below is checked against the actual repo/DB state as of writing,
not summarized from memory. Where I'm not sure, I've said so.

> **2026-07-20 pricing correction:** the one-way-sum design described below
> was proven unsuitable for card prices. For AMS–TLS on 06–12 Dec, it stored
> €176 + €124 = €300 while both the earlier Apify round-trip response (€214)
> and live Google Flights (€213) priced the same KLM itinerary materially
> lower. Current code uses a genuine round-trip search as the authoritative
> fare and a separate return one-way only for shuttle-compatible schedule
> details. `pricing_mode='separate'` is reserved for an explicitly labelled
> two-booking strategy; it is never inferred or substituted silently.

## Branch / diff

`codex/image-ticket-experiment`, uncommitted working tree. Nothing has been
committed this session -- `git status`/`git diff` show the full change list:

```
 M .github/workflows/refresh.yml
 M README.md
 M package.json
 M src/airports.mjs
 M src/apiRoutes.mjs
 M src/catalog.mjs
 M src/db.mjs
 M src/flights.mjs
 M src/validate-airports.mjs
 M src/validation.mjs
 M test/*.mjs (6 files)
 M web/src/App.css, App.jsx, staticCatalog.js, components/*.jsx (7 files)
?? src/apify-screen.mjs   (new: diagnostic CLI, not part of the pipeline)
?? src/providers/         (new: apify.mjs, apify-keys.mjs, serpapi.mjs, index.mjs)
?? test/providers.test.mjs
?? reference/             (pre-existing, untouched by me)
```

23 files, +1235/-231. Nothing has been reviewed by anyone but me.

## What this session was supposed to build (chronological)

1. Origin selector (Netherlands/London/Basel) + early-arrival toggle +
   migrate primary flight provider from SerpApi to an Apify actor.
2. Shuttle-viability filtering: don't quote a flight that lands too late or
   returns too early to catch ground transport to/from the resort.
3. Per the user's explicit correction: filtering must be **permissive**
   (pick the *next* cheapest viable itinerary, not just reject if the
   single cheapest one fails) and **systematic** (a banded rule derived
   from transfer duration, not hand-picked per-airport numbers).
4. Getting real return-leg times required switching from round-trip
   searches to two one-way searches per direction (round-trip responses
   only detail the outbound leg).

## Architecture as it stands

- `src/airports.mjs`: `TRANSFER_BANDS` (duration -> latest-arrival /
  earliest-return-departure) + a `transferHours` scalar per (gateway,
  airport). `AIRPORT_CONFIG_KEY` fingerprints all of it so editing a
  duration or the band table auto-invalidates the freshness ledger.
- `src/providers/`: `apify.mjs` (actor run + poll + key rotation),
  `serpapi.mjs` (fallback), `index.mjs` (priority dispatch). Both `search()`
  functions now accept an optional `returnDate` -- omitted means a one-way
  search.
- `src/flights.mjs`: `parseFlightResponse(..., { direction })` filters
  itineraries by the shuttle window for that direction, then picks cheapest
  **among survivors** (verified in review below). `runFlightRefresh` does 3
  searches per (start,end) week pair: 1 return one-way (shared across both
  arrival modes) + 1 outbound one-way per arrival mode. `combineDirections`
  sums the two one-way prices into the stored row; either side missing =
  stored price is null.
- `src/catalog.mjs` / `web/src/staticCatalog.js`: nested
  `flight_quotes.{nl,uk,ch}.{standard,early}` per week row, resolved
  client-side with no re-fetch on toggle.
- `src/db.mjs`: `flight_price` gained `origin_group`, `arrival_mode`,
  `provider`, `price_outbound`, `price_return`, `return_*` columns,
  `details_scope` ('outbound' = legacy round-trip row from before this
  session's rewrite, 'both' = new one-way-pair row with real return data).
  Additive migration, existing `migrateLegacyNames()` pattern.

## What's actually verified vs. what I'm claiming

**Verified by running it:**
- `npm test` -- 44/44 pass (just re-ran it before writing this doc).
- `npm run lint --prefix web` -- clean.
- `npm run build --prefix web` -- succeeds.
- `npm run export:static && npm run verify:static && npm run validate:airports`
  -- ran clean earlier in the session (before tonight's two bug fixes; not
  re-run after -- see "Not yet re-verified" below).
- The full-season background refresh (`POST /api/flights/refresh`) has now
  **completed**: `{"pairs":35,"modes":2,"searched":105,"skipped":0,"failed":0,
  "noResult":0,"quotaUsed":175,"quotaRemaining":275}` (out of the 450 Apify
  monthly ceiling). Zero error lines in the full log (`grep -c "! "` = 0).
  Verified after completion: every current week pair (35 pairs, catalogue
  range 2026-11-29 to 2027-04-25) has at least one `details_scope='both'`
  row -- **zero week pairs have no new-pipeline coverage**. 402 `both`-scope
  rows now exist alongside 446 leftover `outbound`-scope legacy rows (those
  are historical price-history rows from the old pipeline and are expected
  to remain; `v_flight_current` and the bug-1 fix mean they no longer
  surface as live quotes once a `both`-scope row exists for the same key).

**NOT verified -- take with real skepticism:**
- I have **not** independently re-verified the shuttle-window numbers
  (transfer hours, band thresholds) against a live booking engine. They're
  derived from web searches of aggregate timetable sites, explicitly marked
  "assumption" for several airports in earlier plan iterations, and were
  loosened per the user's direction to be less conservative. **A reviewer
  should treat every number in `TRANSFER_BANDS` and `transferHours` in
  `src/airports.mjs` as unverified until checked against a real transfer
  provider for that specific route.**
- The full-season refresh is still running in the background as of writing.
  Only ~40% of the date range has been processed under the new pipeline.
  Anything beyond mid-March 2027 in the live UI is still showing stale data
  from an earlier, pre-window refresh (see bug #1 below -- this was
  supposed to be handled correctly now, but "supposed to" is exactly the
  problem here).

## Bugs found and fixed THIS SESSION, after being told they were wrong

These are not hypothetical -- they were real, user-caught, in code I had
already called "done" and "verified":

### Bug 1: UI claimed "no flight fits the shuttle" for data that was never checked against a shuttle window at all

`src/catalog.mjs`'s `pickFlightQuote()` returns a quote object whenever
`fetched_at` is non-null, regardless of *which pipeline* produced that row.
Rows from the **original, pre-window, round-trip refresh** (run early this
session, before any of the shuttle-window code existed) have `fetched_at`
set and `price = null` (that old pipeline sometimes just didn't find a
match). The frontend was using `fetched_at != null` as its signal for
"this was properly searched" and displaying **"No flight fits the resort
shuttle"** -- a specific, confident claim about window filtering that never
happened for that row.

User caught this by pasting a real, bookable Google Flights link
(KLM AMS->GVA, 2027-04-25) for a week the UI claimed had "no flight fits."
I verified live: the flight exists, lands at 08:20, comfortably inside the
19:00 window for that gateway -- it just hadn't been re-quoted yet by the
new pipeline (which was still working through December/January/February at
the time).

**Fix applied** (`web/src/components/TicketWeekListing.jsx`): the specific
message now requires `flight_details_scope === "both"` (i.e., actually
produced by the new one-way/window pipeline), not just a non-null
`fetched_at`. Legacy rows fall back to the generic "Flight price
unavailable."

**Not independently re-tested by anyone but me.** A reviewer should
manually check a card whose week has NOT yet been touched by the running
refresh (anything after ~mid-March 2027 right now) and confirm it shows
"Flight price unavailable," not the shuttle-specific message.

### Bug 2 (found investigating bug 1, not yet fixed): batched search does not return all airport-pair combinations

Independent of the window logic: one provider search covers an 8-origin x
9-destination matrix (72 possible pairs) in a single call, but Google/Apify
caps the response to roughly 60-65 itineraries covering only ~21 of the 72
possible pairs. I confirmed this live (see transcript): two back-to-back
identical searches for 2027-04-25 both returned 64 itineraries covering 21
unique pairs, not 72. This means a real, cheaper, bookable flight on an
underrepresented pair can be **entirely absent** from a given search's
results -- not filtered by the shuttle window, just never seen by the code
at all, because the batched query didn't surface it.

In the two test cases I ran, the AMS->GVA flight in question *was* present
both times, so this specific date/pair is not currently broken. But the
general mechanism is real and I have not characterized how often it
actually causes a missed quote across the full dataset. **This is an open
problem, not fixed.** Possible fixes (not implemented, not decided):
narrower per-origin-group searches (more requests, more cost, more
complete), a fallback single-pair search when a cell comes back with zero
raw itineraries, or accepting the gap and documenting it.

## Claims I made in this conversation that turned out to be wrong

Stated plainly since trust is the issue:

1. I told the user the "no flight fits" cases I'd sampled were evidence of
   correct window-filtering behavior, backed by log lines showing
   dropped-itinerary counts. That was true for the cases I actually checked
   in the log, but I had NOT checked whether the specific card the user was
   looking at came from the old or new pipeline before making that claim.
   When they pushed back with a concrete counter-example, it turned out to
   be old-pipeline data -- a case my own "evidence" walkthrough should have
   caught and didn't.
2. Earlier in the session I described the season re-quote as something
   that would "cover the season" -- true eventually, but I did not
   proactively flag that the live UI would show a *mix* of old and new data
   for hours while it ran, which is exactly the condition that produced the
   bug above.

## What I'd want an independent reviewer to actually check

In rough priority order:

1. **Read `src/flights.mjs` `parseFlightResponse` and `runFlightRefresh`
   end to end.** Confirm the viability filter really does "pick cheapest
   among survivors" and not "reject if cheapest fails" -- I believe I've
   verified this (both by code reading and by log evidence showing
   nonzero drop counts alongside successful matches), but given tonight's
   track record, re-derive it yourself rather than trusting this line.
2. **Check `src/airports.mjs` transfer-hour and band numbers** against
   whatever ground-truth source you trust. I sourced them from web search
   summaries of aggregator timetable sites, not a live booking engine, and
   they were explicitly loosened on user request without new evidence
   backing the looser numbers -- they're a policy choice, not a
   measurement.
3. **Confirm the `details_scope` distinction actually holds** for every
   consumer of `flight_quotes`, not just the one component I patched
   (`TicketWeekListing.jsx`). I did not check `TripCost.jsx` /
   `WeekListing.jsx` (the card view behind `SHOW_CARD_VIEW_SWITCH = false`
   in `web/src/App.jsx`) for the same stale-data-mislabeling risk -- it's
   plausible they have the identical bug since they read the same
   `flight_*` fields and I did not audit them tonight.
4. **Verify the batched-search coverage gap (bug 2)** against a broader
   sample than the two manual checks I ran, and decide whether it needs a
   structural fix before this is trustworthy for real trip planning.
5. **The running refresh**: check current progress
   (`tail` the server log, or query
   `SELECT MAX(outbound_date) FROM flight_search WHERE direction='outbound'`)
   and decide whether to let it finish, stop it, or restart it once other
   issues are fixed -- continuing to spend Apify credit on a pipeline under
   active dispute may not be the right call.

## How to reproduce my checks

```bash
npm test                                    # 44 tests, should all pass
npm run lint --prefix web
npm run build --prefix web
npm run apify:screen                        # current credit across 4 keys, no spend
node --input-type=module -e "..."           # ad-hoc DB queries, see this session's
                                             # transcript for the exact queries used
                                             # to find bug 1 (grep flight_price by
                                             # outbound_date and fetched_at)
```

The live server is running on `localhost:8787` (background task, started
this session) with a flight refresh also running in the background
(`POST /api/flights/refresh`, started ~2 hours before this document).
