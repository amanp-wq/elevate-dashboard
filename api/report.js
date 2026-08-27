import { requireUser } from "./_lib/auth.js";
import { buildReport, fetchAllUsers } from "./_lib/report-core.js";

// 300s, not 60. Sixty was the Vercel Hobby ceiling; on Pro this can go to
// five minutes, and these routes need it — a multi-day range fans out to
// dozens of paged COQL queries and was being killed mid-flight. A timeout is
// the one failure the handler cannot turn into a JSON error, so the page got a
// plain-text platform page and reported "not valid JSON" instead of the cause.
export const config = { maxDuration: 300 };

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const CACHE_TTL_MS  = 20 * 60 * 1000; // 20 minutes — matches proactive refresh interval

// In-memory token cache — reuse access token for 50 min to avoid Zoho rate limits
let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

async function getCached(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/report_cache?cache_key=eq.${encodeURIComponent(key)}&select=data,created_at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await r.json();
  if (!rows?.length) return null;
  const age = Date.now() - new Date(rows[0].created_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  return rows[0].data;
}

// Must be awaited by callers. Vercel freezes the instance as soon as the
// response is sent, so calling this fire-and-forget meant the write was
// frequently killed mid-flight — the next request then missed the cache and
// re-queried Zoho. That is why one cache key logged ~82 zoho_call hits in 27
// minutes despite a 20-minute TTL. Failures are swallowed in here so a cache
// problem can never fail the request itself.
async function setCached(key, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/report_cache`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify({ cache_key: key, data, created_at: new Date().toISOString() })
    });
  } catch { /* cache write is best-effort */ }
}

// Must be awaited by callers: on Vercel the instance is frozen as soon as the
// response is sent, so a fire-and-forget insert here was being killed
// mid-flight and api_logs stayed permanently empty (which is also what hid
// the broken report cache for so long — there were no logs to notice it in).
async function logAPI(type, role, date_range, triggered_by, duration_ms) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_logs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type, role, date_range, triggered_by, duration_ms })
    });
  } catch { /* logging must never fail the request */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://elevate-dashboard-iota.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = await requireUser(req);
  if (user.error) return res.status(401).json({ error: user.error });

  const q = req.method === "POST" ? req.body : req.query;
  const { slot, role } = q;
  // Support both a single `date` and an explicit startDate/endDate pair.
  // These must be resolved BEFORE the cache key is built: reading startDate
  // straight off the query while the fetch logic fell back to `date` meant
  // every ?date= request shared the key "role|v2|undefined|undefined" and
  // served whichever day happened to be cached first.
  const startDate = q.startDate || q.date;
  const endDate   = q.endDate   || q.date;

  if (!startDate || !endDate || !slot || !role) {
    return res.status(400).json({ error: "Missing startDate, endDate, slot or role" });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: "startDate must be on or before endDate" });
  }

  // v3: the payload gained per-person `offHours`. Each bump retires the older
  // rows instead of serving a cached payload the hover card can't read.
  //
  // `slot` is deliberately NOT in the key. It never affects the numbers — it is
  // echoed back and nothing reads it — so keying on it would only fragment the
  // cache, and it would silently kill the pre-warm again: every page sends
  // slot=7pm while the cron writes slot="day", so the keys would never meet.
  // Instead the cached payload's stale slot is overwritten on the way out.
  const cacheKey = `${role}|v3|${startDate}|${endDate}`;
  const t0 = Date.now();

  try {
    const cached = await getCached(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      await logAPI("cache_hit", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
      return res.status(200).json({ ...cached, slot });
    }
  } catch (_) { /* cache miss — proceed normally */ }

  try {
    const token = await getAccessToken();
    const allUsers = await fetchAllUsers(token);
    const result = await buildReport({ token, allUsers, role, startDate, endDate, slot });

    await setCached(cacheKey, result);
    await logAPI("zoho_call", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
    return res.status(200).json(result);

  } catch (e) {
    if (e.notFound) {
      return res.status(404).json({ error: e.message, available_roles: e.availableRoles });
    }
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
