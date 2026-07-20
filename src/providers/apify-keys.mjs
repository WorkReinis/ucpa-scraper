// Apify account inventory: every APIFY_KEY_* in the environment, deduped by
// token value, with free-tier credit headroom per account. Shared by the
// flight pipeline (pick the fullest key per run) and the apify-screen CLI
// (human-readable report). Env and fetch are injectable so the pure parts
// test without network or process.env.

const API = "https://api.apify.com/v2";

export const mask = (token) => `…${token.slice(-4)}`;

/** Every APIFY_KEY_* in `env`, deduped by token value. Duplicate names are
 *  kept as aliases so the CLI can warn about them. */
export function collectKeys(env = process.env) {
  const found = Object.entries(env)
    .filter(([name, value]) => /^APIFY_KEY_/.test(name) && value?.trim())
    .map(([name, value]) => ({ name, token: value.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const byToken = new Map();
  for (const entry of found) {
    const existing = byToken.get(entry.token);
    if (existing) existing.aliases.push(entry.name);
    else byToken.set(entry.token, { ...entry, aliases: [] });
  }
  return { unique: [...byToken.values()], total: found.length };
}

/** Account identity + free-tier headroom for one token. Never throws; a bad
 *  key comes back with row.error set so one dead account doesn't take down
 *  the whole screen. */
export async function inspectKey({ name, token, aliases = [] }, fetchImpl = fetch) {
  const row = { name, token, aliases, username: null, plan: null,
    limitUsd: null, usedUsd: null, remainingUsd: null, cycleEnd: null, error: null };
  const get = async (path) => {
    const res = await fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(json?.error?.message ?? `HTTP ${res.status} on ${path}`);
    }
    return json?.data ?? json;
  };
  try {
    const [me, limits] = await Promise.all([get("/users/me"), get("/users/me/limits")]);
    row.username = me?.username ?? me?.id ?? "unknown";
    row.plan = me?.plan?.id ?? me?.plan?.description ?? "free";
    row.limitUsd = limits?.limits?.maxMonthlyUsageUsd ?? null;
    row.usedUsd = limits?.current?.monthlyUsageUsd ?? null;
    row.cycleEnd = limits?.monthlyUsageCycle?.endAt ?? null;
    if (row.limitUsd != null && row.usedUsd != null) {
      row.remainingUsd = Math.max(row.limitUsd - row.usedUsd, 0);
    }
  } catch (e) {
    row.error = e.message;
  }
  return row;
}

export function pickFullest(rows) {
  const usable = rows.filter((r) => r.remainingUsd != null && r.remainingUsd > 0);
  if (!usable.length) return null;
  return usable.reduce((a, b) => (b.remainingUsd > a.remainingUsd ? b : a));
}

export function pooledRemaining(rows) {
  return rows.filter((r) => !r.error).reduce((sum, r) => sum + (r.remainingUsd ?? 0), 0);
}

/** Inventory -> inspect all -> pick. The one call sites actually want. */
export async function screenAndPick(env = process.env, fetchImpl = fetch) {
  const { unique, total } = collectKeys(env);
  const rows = await Promise.all(unique.map((key) => inspectKey(key, fetchImpl)));
  return { rows, total, pooled: pooledRemaining(rows), fullest: pickFullest(rows) };
}
