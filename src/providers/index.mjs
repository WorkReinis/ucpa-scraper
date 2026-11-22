// Google Flights is queried solely through SerpApi. Keeping this narrow
// provider boundary makes it straightforward to add another provider later
// without activating it accidentally.
import * as serpapi from "./serpapi.mjs";

/** The sole active provider, when configured. */
export function configuredProviders(env = process.env) {
  return env.SERPAPI_KEY?.trim() ? ["serpapi"] : [];
}

/** Run the configured provider and return its raw response plus redaction key. */
export async function searchWithProvider(name, {
  originIds, destIds, outboundDate, returnDate, exhaustive = false,
}, env = process.env) {
  if (name === "serpapi") {
    if (!env.SERPAPI_KEY?.trim()) throw new Error("SerpApi is not configured");
    const raw = await serpapi.search({
      originIds, destIds, outboundDate, returnDate, exhaustive, apiKey: env.SERPAPI_KEY,
    });
    return { raw, provider: "serpapi", secrets: [env.SERPAPI_KEY] };
  }
  throw new Error(`unknown flight provider: ${name}`);
}

/**
 * Run SerpApi. `provider` is recorded on stored rows and `secrets` are
 * redacted from diagnostic dumps.
 */
export async function search({
  originIds, destIds, outboundDate, returnDate, exhaustive = false,
}, env = process.env) {
  const providers = configuredProviders(env);
  if (!providers.length) {
    throw new Error("no flight provider configured -- set SERPAPI_KEY");
  }
  return searchWithProvider(providers[0], {
    originIds, destIds, outboundDate, returnDate, exhaustive,
  }, env);
}
