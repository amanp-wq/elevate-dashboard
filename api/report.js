import { requireUser } from "./_lib/auth.js";

export const config = { maxDuration: 60 };

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const CACHE_TTL_MS  = 20 * 60 * 1000; // 20 minutes — matches proactive refresh interval
const API_DOMAIN_COQL = "https://www.zohoapis.in";

// In-memory token cache — reuse access token for 50 min to avoid Zoho rate limits
let _tokenCache = { token: null, expiresAt: 0 };

// Same idea for the user list: it was being re-fetched on every single
// invocation, which showed up in Zoho's credit report as ~5.3k Users-module
// calls in one day (12% of that day's spend) purely to re-read a roster that
// changes maybe once a month. Cached per warm instance.
let _usersCache = { users: null, expiresAt: 0 };
const USERS_TTL_MS = 30 * 60 * 1000;
async function getAccessTokenCached(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
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

// ── Call-duration bands ──────────────────────────────────────────────────────
// Feeds the hover breakdown on each Builder/Closer card: of the calls behind
// the number on the card, how many were quick hangups vs real conversations.
//   red    under 40s        yellow  41s – 2m
//   green  2m – 7m          gold    7m and above
// Only calls that count toward `calls` get bucketed, so the four bands always
// add back up to the figure shown on the card.
function emptyBands() { return { red: 0, yellow: 0, green: 0, gold: 0 }; }
function bandOf(seconds) {
  if (seconds <= 40)  return "red";
  if (seconds <= 120) return "yellow";
  if (seconds <  420) return "green";
  return "gold";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://elevate-dashboard-iota.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = await requireUser(req);
  if (user.error) return res.status(401).json({ error: user.error });

  // ── Cache check ───────────────────────────────────────────────────────────
  const q0 = req.method === "POST" ? req.body : req.query;
  const { startDate, endDate, role } = q0;
  // v2: the payload gained per-person `callBands`. Bumping the key retires v1
  // rows instead of serving a cached payload the hover card can't read.
  const cacheKey = `${role}|v2|${startDate}|${endDate}`;
  const t0 = Date.now();
  try {
    const cached = await getCached(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      await logAPI("cache_hit", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
      return res.status(200).json(cached);
    }
  } catch(_) { /* cache miss — proceed normally */ }

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
  const AUTH_DOMAIN   = "https://accounts.zoho.in";
  const API_DOMAIN    = "https://www.zohoapis.in";

  const getAccessToken = () => getAccessTokenCached(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);

  async function zohoGet(token, url) {
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) return {};
    return r.json();
  }

  // ── Concurrency limiter + retry, so we don't overrun Zoho's rate limit and
  //    never silently drop data on a 429/5xx (same pattern as funnel.js/bde.js). ──
  function makeLimiter(max) {
    let active = 0; const q = [];
    const pump = () => { while (active < max && q.length) { active++; (q.shift())(); } };
    return fn => new Promise((resolve, reject) => {
      q.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
      pump();
    });
  }
  const _limit = makeLimiter(8);
  async function zohoFetch(url, opts) {
    return _limit(async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, opts);
        if ((r.status === 429 || r.status >= 500) && attempt < 6) {
          await new Promise(res => setTimeout(res, Math.min(800 * 2 ** attempt, 12000) + Math.floor(Math.random() * 300)));
          continue;
        }
        return r;
      }
    });
  }

  // COQL reads LIVE data (not the eventually-consistent /search index), same
  // migration already done in funnel.js/bde.js. Fetched per-day to stay under
  // COQL's 2000-record ceiling.
  async function fetchByDateRange(token, module, select, startDate, endDate, dateField) {
    const dates = [];
    const d = new Date(startDate + "T12:00:00Z");
    const end = new Date(endDate + "T12:00:00Z");
    while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

    async function fetchOneDay(date) {
      let all = [], offset = 0;
      while (true) {
        const q = `select ${select} from ${module} where ${dateField} = '${date}' limit ${offset}, 200`;
        const r = await zohoFetch(`${API_DOMAIN_COQL}/crm/v2/coql`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ select_query: q }),
        });
        if (r.status === 204) break;
        const data = await r.json();
        if (!data?.data?.length) break;
        all = all.concat(data.data);
        if (!data.info?.more_records) break;
        offset += 200;
        if (offset >= 2000) break;
      }
      return all;
    }

    let all = [];
    const BATCH = 6;
    for (let i = 0; i < dates.length; i += BATCH) {
      const results = await Promise.all(dates.slice(i, i + BATCH).map(fetchOneDay));
      results.forEach(r => { all = all.concat(r); });
    }
    return all;
  }

  // Instant of 00:00:00 America/New_York on `dateStr`, as a UTC Date — DST-safe.
  // The business runs on US Eastern hours (see WORK_START_H elsewhere in the
  // app) — day windows must use that timezone, not a fixed offset, or the
  // boundary silently spans parts of two different Eastern days and
  // overcounts (confirmed against Zoho's own UI count while root-causing this
  // on test: an IST-boundary window gave 242 calls for a day Zoho reports as 139).
  function nyMidnightUTC(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET regardless of DST
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = dtf.formatToParts(noonGuessUTC).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    const offsetMin = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - noonGuessUTC.getTime()) / 60000;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
  }
  const fmtCOQL = d => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

  async function coqlCallsWindow(token, startDT, endDT) {
    const out = [];
    let offset = 0;
    while (true) {
      const q = `select Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
              + `from Calls where Call_Start_Time between '${startDT}' and '${endDT}' limit ${offset}, 200`;
      const r = await zohoFetch(`${API_DOMAIN_COQL}/crm/v2/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ select_query: q }),
      });
      if (r.status === 204) break;
      const data = await r.json();
      if (!data?.data?.length) break;
      out.push(...data.data);
      if (!data.info?.more_records) break;
      offset += 200;
      if (offset >= 2000) break;
    }
    return out;
  }
  async function fetchCallsForRange(token, startDate, endDate) {
    const dates = [];
    const d = new Date(startDate + "T12:00:00Z");
    const end = new Date(endDate + "T12:00:00Z");
    while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

    // Split each day into 4 × 6-hour windows so no single window exceeds
    // the 2000-record COQL pagination cap. Work hours (10:30 AM – 7:30 PM ET)
    // concentrate ~80% of calls in the noon–midnight half; with 2 windows
    // that half was silently truncated at 2000 records, dropping ~400 calls
    // per day.  Four windows keep each chunk under 1000 records comfortably.
    async function oneDay(date) {
      const dayStart = nyMidnightUTC(date);
      const H6  = 6 * 60 * 60 * 1000;
      const windows = [];
      for (let i = 0; i < 4; i++) {
        const wStart = new Date(dayStart.getTime() + i * H6);
        const wEnd   = new Date(dayStart.getTime() + (i + 1) * H6 - 1000);
        windows.push([fmtCOQL(wStart), fmtCOQL(wEnd)]);
      }
      const parts = await Promise.all(windows.map(([s, e]) => coqlCallsWindow(token, s, e)));
      return parts.flat();
    }

    let all = [];
    const BATCH = 5;
    for (let i = 0; i < dates.length; i += BATCH) {
      const results = await Promise.all(dates.slice(i, i + BATCH).map(oneDay));
      results.forEach(r => { all = all.concat(r); });
    }
    return all;
  }

  try {
    const q = req.method === "POST" ? req.body : req.query;
    const { slot, role } = q;
    // Support both single `date` and `startDate`/`endDate`
    const startDate = q.startDate || q.date;
    const endDate   = q.endDate   || q.date;

    if (!startDate || !endDate || !slot || !role) {
      return res.status(400).json({ error: "Missing startDate, endDate, slot or role" });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: "startDate must be on or before endDate" });
    }

    const token = await getAccessToken();

    let allUsers;
    if (_usersCache.users && Date.now() < _usersCache.expiresAt) {
      allUsers = _usersCache.users;
    } else {
      const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
      allUsers = ud?.users || [];
      if (allUsers.length) _usersCache = { users: allUsers, expiresAt: Date.now() + USERS_TTL_MS };
    }
    const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));

    if (!users.length) {
      const roleNames = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
      return res.status(404).json({ error: `No users found matching "${role}".`, available_roles: roleNames });
    }

    const isCloser   = role.toLowerCase().includes("closer");
    const isTeamLead = role.toLowerCase().includes("team leader");

    // Extract the team-lead name from the Zoho role, e.g.
    // "Builder - Soham Bajpai" → "Soham", "Closer - Mamta Das" → "Mamta Das".
    // Falls back to empty string for roles without a " - " separator.
    function tlFromRole(roleName) {
      const m = (roleName || "").match(/(?:Builder|Closer)\s*-\s*(.+)/i);
      if (!m) return "";
      const full = m[1].trim();                         // "Soham Bajpai"
      // Check well-known two-word TL names first
      if (/^Mamta\b/i.test(full))  return "Mamta Das";
      return full.split(/\s+/)[0];                      // first name: "Soham", "Tejasvi"
    }

    // Build a userId → teamLead lookup from the users list so every person
    // gets a team lead even if they have zero leads/deals in the period.
    const userTLMap = {};
    allUsers.forEach(u => { userTLMap[u.id] = tlFromRole(u.role?.name); });

    // ── TEAM LEADER REPORT ───────────────────────────────────────────────────
    if (isTeamLead) {
      const tlMembers = allUsers.filter(u => {
        const r = u.role?.name || "";
        return tlFromRole(r) && (r.includes("Builder") || r.includes("Closer"));
      });

      const builderMap = {}, closerMap = {};
      tlMembers.forEach(u => {
        const tl = tlFromRole(u.role.name);
        const isC = u.role.name.includes("Closer");
        const base = { name: u.full_name, id: u.id, tlName: tl,
          calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands() };
        if (isC) closerMap[u.id]  = { ...base, presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
        else     builderMap[u.id] = { ...base, leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
      });

      const CF = "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status";
      const [calls, presHeld, closedDeals, upfrontDeals,
             leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
        fetchCallsForRange(token, startDate, endDate),
        fetchByDateRange(token, "Deals", "Owner,Team_Lead",                        startDate, endDate, "Presentation_Completed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead",  startDate, endDate, "Deal_Closed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Upfront_Amount,Team_Lead",         startDate, endDate, "Upfront_Amount_Received_Date"),
        fetchByDateRange(token, "Leads", "Owner,Team_Lead",                        startDate, endDate, "Qualified_Lead_Date"),
        fetchByDateRange(token, "Leads", "Owner,Team_Lead",                        startDate, endDate, "Discovery_Completed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",                startDate, endDate, "Qualified_Lead_Date"),
        fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",                startDate, endDate, "Discovery_Completed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",                startDate, endDate, "Presentation_Booked_Date"),
        fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",                startDate, endDate, "Presentation_Completed_Date"),
      ]);

      calls.forEach(c => {
        const id = c.Owner?.id;
        const mins = parseFloat(c.Call_Duration_in_seconds || 0) / 60;
        const map = builderMap[id] ? builderMap : closerMap[id] ? closerMap : null;
        if (!map) return;
        map[id].minutes += mins;
        if (c.Call_Status === "Missed") { map[id].missed += 1; }
        else if (c.Call_Type === "Inbound") { map[id].inbound += 1; }
        else {
          map[id].calls += 1; map[id].outbound += 1;
          map[id].callBands[bandOf(parseFloat(c.Call_Duration_in_seconds || 0))] += 1;
        }
      });

      // Builder KPIs
      leadsQL.forEach(l  => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].leads++; });
      leadsDisc.forEach(l => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].discoveries++; });
      dealsQL.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].leads++; });
      dealsDisc.forEach(d => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].discoveries++; });
      dealsPB.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presBooked++; });
      dealsPC.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presCompleted++; });

      // Closer KPIs
      presHeld.forEach(d    => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].presentations++; });
      closedDeals.forEach(d => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].futureUpfront += parseFloat(d.Future_Booked_Upfront||0); });
      upfrontDeals.forEach(d=> { const id=d.Owner?.id; if(closerMap[id]) { closerMap[id].dealsClosed++; closerMap[id].newUpfront += parseFloat(d.Upfront_Amount||0); } });

      const roundCloser = c => ({ ...c, minutes:Math.round(c.minutes), newUpfront:Math.round(c.newUpfront), futureUpfront:Math.round(c.futureUpfront), revenue:Math.round(c.newUpfront+c.futureUpfront) });
      const roundBuilder = b => ({ ...b, minutes:Math.round(b.minutes) });

      const teams = {};
      ["Soham","Tejasvi","Mamta Das"].forEach(tl => {
        teams[tl] = {
          builders: Object.values(builderMap).filter(b=>b.tlName===tl).map(roundBuilder),
          closers:  Object.values(closerMap).filter(c=>c.tlName===tl).map(roundCloser),
        };
      });

      const result = { teams, startDate, endDate, slot, role };
      await setCached(cacheKey, result);
      await logAPI("zoho_call", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
      return res.status(200).json(result);
    }

    // ── CLOSER REPORT ────────────────────────────────────────────────────────
    if (isCloser) {
      const map = {};
      users.forEach(u => {
        map[u.id] = { name: u.full_name, id: u.id, teamLead: userTLMap[u.id] || "",
          calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands(),
          presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
      });

      const CALL_FIELDS = "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status";
      const [calls, presHeld, closedDeals, upfrontDeals] = await Promise.all([
        fetchCallsForRange(token, startDate, endDate),
        fetchByDateRange(token, "Deals", "Owner,Team_Lead", startDate, endDate, "Presentation_Completed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead", startDate, endDate, "Deal_Closed_Date"),
        fetchByDateRange(token, "Deals", "Owner,Upfront_Amount,Team_Lead", startDate, endDate, "Upfront_Amount_Received_Date"),
      ]);

      calls.forEach(c => {
        const id = c.Owner?.id;
        if (!map[id]) return;
        map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
        if (c.Call_Status === "Missed") { map[id].missed += 1; return; }
        if (c.Call_Type === "Inbound")  { map[id].inbound += 1; return; }
        map[id].calls += 1;
        map[id].outbound += 1;
        map[id].callBands[bandOf(parseFloat(c.Call_Duration_in_seconds || 0))] += 1;
      });

      presHeld.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].presentations += 1;
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      closedDeals.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].futureUpfront += parseFloat(d.Future_Booked_Upfront || 0);
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      upfrontDeals.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].dealsClosed += 1;
        map[id].newUpfront += parseFloat(d.Upfront_Amount || 0);
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      const closers = Object.values(map).map(b => ({
        ...b,
        minutes: Math.round(b.minutes),
        newUpfront: Math.round(b.newUpfront),
        futureUpfront: Math.round(b.futureUpfront),
        revenue: Math.round(b.newUpfront + b.futureUpfront),
      }));
      const result = { closers, startDate, endDate, slot, role };
      await setCached(cacheKey, result);
      await logAPI("zoho_call", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
      return res.status(200).json(result);
    }

    // ── BUILDER REPORT ───────────────────────────────────────────────────────
    const map = {};
    users.forEach(u => {
      map[u.id] = { name: u.full_name, id: u.id, teamLead: userTLMap[u.id] || "",
        calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands(),
        leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
    });

    const CALL_FIELDS = "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status";
    const [calls, leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
      fetchCallsForRange(token, startDate, endDate),
      fetchByDateRange(token, "Leads", "Owner,Team_Lead", startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Leads", "Owner,Team_Lead", startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Booked_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Completed_Date"),
    ]);

    calls.forEach(c => {
      const id = c.Owner?.id;
      if (!map[id]) return;
      map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
      if (c.Call_Status === "Missed") { map[id].missed += 1; return; }
      if (c.Call_Type === "Inbound")  { map[id].inbound += 1; return; }
      map[id].calls += 1;
      map[id].outbound += 1;
      map[id].callBands[bandOf(parseFloat(c.Call_Duration_in_seconds || 0))] += 1;
    });

    leadsQL.forEach(l => { const id = l.Owner?.id; if (!map[id]) return; map[id].leads += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; });
    leadsDisc.forEach(l => { const id = l.Owner?.id; if (!map[id]) return; map[id].discoveries += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; });
    dealsQL.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].leads += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsDisc.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].discoveries += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsPB.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].presBooked += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsPC.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].presCompleted += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    const result = { builders, startDate, endDate, slot, role };
    await setCached(cacheKey, result);
    await logAPI("zoho_call", role, `${startDate} to ${endDate}`, "user", Date.now() - t0);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
