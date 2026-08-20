// Diagnostic endpoint for call-count mismatches between the dashboard and
// Zoho's own UI counts. Admin-only, read-only, writes nothing and caches nothing.
//
// Answers two questions in one request:
//   1. Is the day boundary wrong? Zoho's UI "On <date>" filter evaluates in the
//      Zoho ORG timezone; report.js queries America/New_York midnight->midnight.
//      If the org is on IST those are different 24h windows, ~9.5h apart. This
//      pulls a wide 48h window and buckets every call by BOTH ET and IST
//      calendar date, so the two counts can be compared directly.
//   2. Are calls being dropped on owner lookup? report.js discards any call
//      whose Owner.id is not in the role map (`if (!map[id]) return`). This
//      lists every unmatched owner with their name and Zoho role so a
//      missing/misnamed role shows up by name instead of as a silent undercount.
//
// Usage: /api/debug?date=2026-08-19&role=Closer

import { requireUser } from "./_lib/auth.js";

export const config = { maxDuration: 60 };

const API_DOMAIN = "https://www.zohoapis.in";

async function getAccessToken() {
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
  return data.access_token;
}

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
        await new Promise(res => setTimeout(res, Math.min(800 * 2 ** attempt, 12000) + Math.random() * 300));
        continue;
      }
      return r;
    }
  });
}

// Identical to report.js — instant of 00:00 America/New_York, DST-safe.
function nyMidnightUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(noonGuessUTC).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const offsetMin = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - noonGuessUTC.getTime()) / 60000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
}
const fmtCOQL = d => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

async function coqlCallsWindow(token, startDT, endDT) {
  const out = [];
  let offset = 0;
  let truncated = false;
  while (true) {
    const q = `select Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
            + `from Calls where Call_Start_Time between '${startDT}' and '${endDT}' limit ${offset}, 200`;
    const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
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
    if (offset >= 2000) { truncated = true; break; }
  }
  return { rows: out, truncated };
}

const dateIn = (tz, d) => d.toLocaleDateString("en-CA", { timeZone: tz });

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://elevate-dashboard-iota.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = await requireUser(req, { adminOnly: true });
  if (user.error) return res.status(401).json({ error: user.error });

  const date = req.query.date;
  const role = req.query.role || "Closer";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Pass ?date=YYYY-MM-DD (and optionally &role=Closer)" });
  }

  try {
    const token = await getAccessToken();

    // Full roster, unfiltered by active status, so an owner that report.js
    // would drop can still be named here.
    const ud = await fetch(`${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    }).then(r => r.json());
    const allUsers = ud?.users || [];
    const byId = {};
    allUsers.forEach(u => { byId[u.id] = { name: u.full_name, role: u.role?.name || "", status: u.status }; });

    // The exact set report.js builds its map from.
    const roleUsers = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));
    const inRole = new Set(roleUsers.map(u => u.id));

    // 48h wide window centred on the target ET day: ET midnight -12h to +36h.
    // Covers the IST interpretation of the same calendar date completely.
    const etMidnight = nyMidnightUTC(date);
    const H6 = 6 * 60 * 60 * 1000;
    const wideStart = new Date(etMidnight.getTime() - 12 * 60 * 60 * 1000);
    const windows = [];
    for (let i = 0; i < 8; i++) {
      windows.push([
        fmtCOQL(new Date(wideStart.getTime() + i * H6)),
        fmtCOQL(new Date(wideStart.getTime() + (i + 1) * H6 - 1000)),
      ]);
    }
    const parts = await Promise.all(windows.map(([s, e]) => coqlCallsWindow(token, s, e)));
    const anyTruncated = parts.some(p => p.truncated);
    const wide = parts.flatMap(p => p.rows);

    // Classify every call in the wide window.
    const etDay = {}, istDay = {};      // calendar date -> count, for role-owned calls
    const unmatched = {};               // owner id -> { name, role, status, count }
    const roleTally = {};               // Zoho role name -> outbound count on the ET day
    let etDayRows = [];
    let etDayAllOwners = 0;             // ET-day outbound across EVERY owner, no role filter

    wide.forEach(c => {
      const t = new Date(c.Call_Start_Time);
      const et = dateIn("America/New_York", t);
      const ist = dateIn("Asia/Kolkata", t);
      const id = c.Owner?.id;
      const isOutbound = c.Call_Type !== "Inbound" && c.Call_Status !== "Missed";

      // Only outbound-equivalent calls, to match the Zoho UI filter being compared against.
      if (!isOutbound) return;

      if (et === date) {
        etDayAllOwners++;
        const rn = byId[id]?.role || "(owner not in user list)";
        roleTally[rn] = (roleTally[rn] || 0) + 1;
      }

      if (inRole.has(id)) {
        if (et === date)  etDay[et]   = (etDay[et]  || 0) + 1;
        if (ist === date) istDay[ist] = (istDay[ist] || 0) + 1;
      } else if (et === date || ist === date) {
        const info = byId[id] || { name: `(unknown id ${id})`, role: "", status: "" };
        const key = id || "(no owner)";
        if (!unmatched[key]) unmatched[key] = { ...info, count: 0 };
        unmatched[key].count++;
      }

      if (et === date) etDayRows.push(c);
    });

    // Full Call_Type x Call_Status breakdown for the ET day, role-owned only —
    // this is what report.js actually sees and buckets.
    const breakdown = {};
    etDayRows.forEach(c => {
      if (!inRole.has(c.Owner?.id)) return;
      const k = `${c.Call_Type || "(none)"} / ${c.Call_Status || "(none)"}`;
      breakdown[k] = (breakdown[k] || 0) + 1;
    });

    const etCount  = etDay[date]  || 0;
    const istCount = istDay[date] || 0;
    const unmatchedTotal = Object.values(unmatched).reduce((s, u) => s + u.count, 0);

    return res.status(200).json({
      date, role,
      warning: anyTruncated
        ? "A 6h window hit the 2000-record COQL cap — counts below are truncated."
        : null,

      // The headline comparison.
      outboundCount: {
        etBoundary_whatDashboardUses: etCount,
        istBoundary_ifZohoOrgIsOnIST: istCount,
        difference: istCount - etCount,
      },

      // If this is much larger than etBoundary above, the role filter
      // (`role.toLowerCase().includes("closer")`) is too narrow — Zoho's
      // "belongs to Role" filter also picks up subordinate roles.
      etDayOutbound_allOwnersNoRoleFilter: etDayAllOwners,
      etDayOutbound_byZohoRole: Object.fromEntries(
        Object.entries(roleTally).sort((a, b) => b[1] - a[1])
      ),

      // Calls inside the day (either boundary) whose owner report.js would drop.
      droppedOnOwnerLookup: {
        total: unmatchedTotal,
        owners: Object.entries(unmatched)
          .map(([id, u]) => ({ id, ...u }))
          .sort((a, b) => b.count - a.count),
      },

      callTypeStatusBreakdown_etDay: breakdown,

      roster: {
        usersMatchingRole: roleUsers.length,
        names: roleUsers.map(u => `${u.full_name} — ${u.role?.name || "?"} — ${u.status}`).sort(),
      },

      wideWindowTotalRows: wide.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
