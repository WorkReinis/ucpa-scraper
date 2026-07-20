// Provider seam for flight searches: Apify actor primary (cheap, multi-key),
// SerpApi fallback (free 250/month). Both return the same SerpApi-shaped
// response object, so src/flights.mjs parses either identically.
//
// FLIGHT_PROVIDER=apify|serpapi forces a single provider -- the rollback
// lever if the community actor breaks or an account gets locked.

import * as apify from "./apify.mjs";
import * as serpapi from "./serpapi.mjs";

// Run-count ceiling for Apify across all keys per calendar month.
// ~$20/month pooled free credit at ~$0.03/run is ~666 runs; the one-way
// cadence (3 searches per week pair) worst-cases near 500/month at 6-day
// freshness, so 450 caps spend at ~$13.50 while covering normal cycles.
// A deliberate one-off backfill can raise this guard without weakening the
// provider's separate live-credit reserve (for example:
// APIFY_MONTHLY_RUN_LIMIT=500 npm run flights).
const configuredApifyLimit = Number.parseInt(process.env.APIFY_MONTHLY_RUN_LIMIT ?? "", 10);
export const MONTHLY_RUN_LIMIT_APIFY = Number.isInteger(configuredApifyLimit) && configuredApifyLimit > 0
  ? configuredApifyLimit
  : 450;

/** Priority-ordered provider names actually configured in `env`. */
export function configuredProviders(env = process.env) {
  if (env.FLIGHT_PROVIDER === "serpapi") return env.SERPAPI_KEY ? ["serpapi"] : [];
  if (env.FLIGHT_PROVIDER === "apify") return hasApifyKeys(env) ? ["apify"] : [];
  const list = [];
  if (hasApifyKeys(env)) list.push("apify");
  if (env.SERPAPI_KEY) list.push("serpapi");
  return list;
}

function hasApifyKeys(env) {
  return Object.entries(env).some(([name, value]) => /^APIFY_KEY_/.test(name) && value?.trim());
}

/** Run exactly one named provider. Keeping fallback outside this function
 * lets flights.mjs create one quota-ledger row for every real provider
 * request, including a failed Apify attempt followed by SerpApi. */
export async function searchWithProvider(name, {
  originIds, destIds, outboundDate, returnDate, exhaustive = false,
}, env = process.env) {
  if (name === "apify") {
    if (!hasApifyKeys(env)) throw new Error("Apify is not configured");
    const { raw, token } = await apify.search({
      originIds, destIds, outboundDate, returnDate, exhaustive,
    }, env);
    return { raw, provider: "apify", secrets: [token] };
  }
  if (name === "serpapi") {
    if (!env.SERPAPI_KEY) throw new Error("SerpApi is not configured");
    const raw = await serpapi.search({
      originIds, destIds, outboundDate, returnDate, exhaustive, apiKey: env.SERPAPI_KEY,
    });
    return { raw, provider: "serpapi", secrets: [env.SERPAPI_KEY] };
  }
  throw new Error(`unknown flight provider: ${name}`);
}

/**
 * Try each configured provider in order until one succeeds. Returns
 * { raw, provider, secrets } -- `provider` is recorded on the stored rows
 * for accounting; `secrets` are the credentials that must be redacted from
 * any diagnostic dump of `raw`.
 */
export async function search({
  originIds, destIds, outboundDate, returnDate, exhaustive = false,
}, env = process.env) {
  const providers = configuredProviders(env);
  if (!providers.length) {
    throw new Error("no flight provider configured -- set APIFY_KEY_1.. or SERPAPI_KEY");
  }
  let lastError;
  for (const name of providers) {
    try {
      return await searchWithProvider(name, {
        originIds, destIds, outboundDate, returnDate, exhaustive,
      }, env);
    } catch (e) {
      console.error(`  ! provider ${name} failed:`, e.message);
      lastError = e;
    }
  }
  throw lastError;
}
