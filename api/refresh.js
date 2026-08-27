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
const CRON_SECRET   = process.env.CRON_SECRET; // no fallback — unset means this path is closed

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const AUTH_DOMAIN   = "https://accounts.zoho.in";

// Report building lives in _lib/report-core.js, shared with api/report.js.
// This route used to carry its own copy, which drifted four separate ways and
// — because both write the SAME cache key — kept overwriting good payloads with
// worse ones that the dashboard then served as cache HITs. Do not reintroduce a
// local copy here; change the core instead.
const ROLES = ["Builder", "Closer", "Team Leader"];

// Must match api/report.js's key exactly, or the pre-warm writes rows nothing
// ever reads. `slot` is intentionally absent from both — see the note there.
const cacheKeyFor = (role, date) => `${role}|v3|${date}|${date}`;

function getTodayEST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function anyoneActiveRecently() {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_activity?created_at=gte.${since}&limit=1&select=id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Must be awaited: Vercel freezes the instance the moment the response is sent,
// so a fire-and-forget insert here was killed mid-flight and cron runs left no
// trace in api_logs at all. Failures are swallowed so logging can't fail the job.
async function logAPI(type, role, date_range, triggered_by, duration_ms) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_logs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type, role, date_range, triggered_by, duration_ms })
    });
  } catch { /* logging must never fail the job */ }
}

// Errors are swallowed: this ran inside Promise.all across all three roles, so
// one failed Supabase write used to reject the whole batch and leave every role
// unrefreshed with a 500.
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

// In-memory token cache — reuse for 50 min to avoid Zoho rate limits
let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch(`${AUTH_DOMAIN}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://elevate-dashboard-iota.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cron-secret");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Two legitimate callers: Vercel's scheduler (x-cron-secret header, never sent
  // to the browser) or an admin manually clicking "force refresh" (their own
  // Supabase session token). No client-side secret in query params anymore.
  const secret = req.headers["x-cron-secret"];
  const isCron = !!CRON_SECRET && secret === CRON_SECRET;
  if (!isCron) {
    const user = await requireUser(req, { adminOnly: true });
    if (user.error) return res.status(401).json({ error: user.error });
  }

  try {
    // Skip unless someone was active in the last 30 min (force=true overrides)
    const force = req.query.force === "true";
    if (!force) {
      const active = await anyoneActiveRecently();
      if (!active) {
        await logAPI("cron_skip", null, null, "cron", 0);
        return res.status(200).json({ skipped: true, reason: "No active users in last 30 min" });
      }
    }

    const date  = getTodayEST();
    const t0    = Date.now();
    const token = await getAccessToken();
    const allUsers = await fetchAllUsers(token);

    // Pre-warm all three roles in parallel. One role failing must not take the
    // others down, so each settles independently and the response reports which
    // ones actually landed.
    const results = await Promise.allSettled(ROLES.map(async role => {
      const payload = await buildReport({ token, allUsers, role, startDate: date, endDate: date, slot: "day" });
      await setCached(cacheKeyFor(role, date), payload);
      return role;
    }));

    const refreshed = ROLES.filter((_, i) => results[i].status === "fulfilled");
    const failed = ROLES
      .map((role, i) => results[i].status === "rejected" ? { role, error: results[i].reason?.message || "unknown" } : null)
      .filter(Boolean);

    await logAPI("cron_run", "all", date, isCron ? "cron" : "admin", Date.now() - t0);
    return res.status(failed.length ? 207 : 200).json({ ok: !failed.length, date, refreshed, failed });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
