// Single source of truth for building Builder / Closer / Team Leader reports.
//
// This used to live twice: once in api/report.js (serving the dashboard) and
// again in api/refresh.js (the cron + admin "Force" pre-warm). Both write to
// the SAME cache key, so any drift between them meant the pre-warm could
// overwrite a good payload with a worse one and the dashboard would serve it
// as a cache HIT. That happened four separate ways:
//
//   * refresh.js never had `callBands`, so once the cache keys were aligned the
//     per-card call-quality hover started reading undefined and showed
//     "No calls in this period" on cards with hundreds of calls.
//   * refresh.js kept a hardcoded getTLName() after report.js moved to
//     tlFromRole(), and set `teamLead: ""` instead of using the user map.
//   * refresh.js stayed on 2x12h call windows after report.js moved to 4x6h to
//     stay under the COQL 2000-record cap.
//   * refresh.js fetched ActiveUsers after report.js moved to AllUsers.
//
// Both callers now go through buildReport() so a fix lands in one place.

const API_DOMAIN = "https://www.zohoapis.in";

// COQL refuses an offset at or beyond 2000, so any single window holding more
// than that cannot be read by paging alone — it has to be split into narrower
// spans. Both fetchers below check against this.
const COQL_OFFSET_CEILING = 2000;

// ── Call-duration bands ──────────────────────────────────────────────────────
// Feeds the hover breakdown on each card: of the calls behind the number on the
// card, how many were quick hangups vs real conversations.
//   red    under 40s        yellow  41s – 2m
//   green  2m – 7m          gold    7m and above
// Only calls that count toward `calls` get bucketed, so the four bands always
// add back up to the figure shown on the card.
export function emptyBands() { return { red: 0, yellow: 0, green: 0, gold: 0 }; }

// ── Off-hours calls ─────────────────────────────────────────────────────────
// Working hours are 10:30 AM - 7:30 PM ET, matching the window target
// proration uses. A call outside them still counts toward the card figure and
// its duration band; these counters only record *when* it happened, so an
// unusual pattern is visible instead of averaging away into a day total.
//
// The formatter is built once: constructing Intl.DateTimeFormat per call is
// what makes this expensive, and a busy day carries thousands of calls.
const WORK_START_H = 10.5, WORK_END_H = 19.5;
const _etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  weekday: "short", hour: "2-digit", minute: "2-digit",
});
export function offHoursOf(callStartTime) {
  const d = new Date(callStartTime);
  if (isNaN(d)) return null;                       // unparseable: do not guess
  const p = _etParts.formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  // hour12:false yields "24" for midnight in some ICU builds.
  const h = (+p.hour % 24) + (+p.minute) / 60;
  if (p.weekday === "Sat" || p.weekday === "Sun") return "weekend";
  if (h < WORK_START_H) return "early";
  if (h >= WORK_END_H)  return "late";
  return null;
}
export function emptyOffHours() { return { early: 0, late: 0, weekend: 0 }; }
function bandOf(seconds) {
  if (seconds <= 40)  return "red";
  if (seconds <= 120) return "yellow";
  if (seconds <  420) return "green";
  return "gold";
}

// Zoho marks offboarded staff inactive but keeps their role name, so the user
// list must include them (their calls still need attributing — see fetchAllUsers)
// while the *roster* must not. An inactive person with no activity in the period
// is dropped: left in, they'd show as a 0% Red card and, because team targets
// are computed client-side as `members x per-person target`, silently inflate
// every team total on the dashboard.
const isActive = u => (u.status || "active").toLowerCase() === "active";
function hadActivity(p) {
  return !!(p.calls || p.inbound || p.missed || p.minutes
    || p.presentations || p.dealsClosed || p.newUpfront || p.futureUpfront
    || p.leads || p.discoveries || p.presBooked || p.presCompleted);
}
// Strips the internal _active flag so it never reaches the cached payload.
function rosterOf(map) {
  return Object.values(map)
    .filter(p => p._active || hadActivity(p))
    .map(({ _active, ...rest }) => rest);
}

// Extract the team-lead name from the Zoho role, e.g.
// "Builder - Soham Bajpai" → "Soham", "Closer - Mamta Das" → "Mamta Das".
// Falls back to empty string for roles without a " - " separator.
export function tlFromRole(roleName) {
  const m = (roleName || "").match(/(?:Builder|Closer)\s*-\s*(.+)/i);
  if (!m) return "";
  const full = m[1].trim();
  if (/^Mamta\b/i.test(full)) return "Mamta Das";
  return full.split(/\s+/)[0];
}

// ── Zoho transport: concurrency limiter + retry ──────────────────────────────
// Shared across every caller in a warm instance so three roles refreshing in
// parallel can't collectively overrun Zoho's rate limit.
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
async function zohoGet(token, url) {
  const r = await zohoFetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return {};
  return r.json();
}

// The roster was being re-fetched on every invocation, which showed up in
// Zoho's credit report as ~5.3k Users-module calls in one day (12% of that
// day's spend) purely to re-read a list that changes maybe once a month.
let _usersCache = { users: null, expiresAt: 0 };
const USERS_TTL_MS = 30 * 60 * 1000;

// AllUsers, not ActiveUsers: a closer/builder deactivated in Zoho mid-period
// still owns calls logged before their status changed. ActiveUsers excluded them
// from the id→person map, so their calls were silently dropped at the
// `if (!map[id]) return` guards below, undercounting the role's total against
// Zoho's own count. rosterOf() keeps them out of the displayed roster.
export async function fetchAllUsers(token) {
  if (_usersCache.users && Date.now() < _usersCache.expiresAt) return _usersCache.users;
  const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`);
  const users = ud?.users || [];
  if (users.length) _usersCache = { users, expiresAt: Date.now() + USERS_TTL_MS };
  return users;
}

// COQL reads LIVE data (not the eventually-consistent /search index), so counts
// are exact and identical across tokens. Fetched per-day to stay under COQL's
// 2000-record ceiling.
async function fetchByDateRange(token, module, select, startDate, endDate, dateField) {
  const dates = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

  async function fetchOneDay(date) {
    let all = [], offset = 0;
    while (true) {
      const q = `select ${select} from ${module} where ${dateField} = '${date}' limit ${offset}, 200`;
      const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
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
      // Per-day volume here (qualified leads, discoveries, presentations,
      // closed deals) sits far below this, so hitting it means something has
      // changed rather than a routine busy day. Better a visible error than a
      // total that is quietly short.
      if (offset >= COQL_OFFSET_CEILING) {
        throw new Error(
          `${module}.${dateField} on ${date} exceeds COQL's ${COQL_OFFSET_CEILING}-record `
          + `limit; this fetch needs splitting by time like the Calls one`);
      }
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
// The business runs on US Eastern hours, so day windows must use that timezone,
// not a fixed offset, or the boundary silently spans parts of two different
// Eastern days and overcounts (confirmed against Zoho's own UI count: an
// IST-boundary window gave 242 calls for a day Zoho reports as 139).
function nyMidnightUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET regardless of DST
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
    if (offset >= COQL_OFFSET_CEILING) { truncated = true; break; }
  }
  return { rows: out, truncated };
}


async function fetchCallsForRange(token, startDate, endDate) {
  const dates = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

  // A window that comes back at the offset ceiling is re-read as two halves.
  // The query carries no owner filter, so a window holds every call in the org
  // for that span, not just this role's -- org volume, not role volume, is what
  // pushes a window over 2000, and it grows as the company does. Splitting on
  // demand keeps the read complete without paying for narrow windows on quiet
  // days.
  //
  // The floor is one minute: below that a split cannot help, because more than
  // 2000 calls inside a single minute would be the same records regardless of
  // how the span is cut. Reaching it means data really is being lost, so it
  // throws rather than returning a short count that looks fine.
  const MIN_SPAN_MS = 60 * 1000;
  async function readSpan(fromMs, toMs, depth = 0) {
    const { rows, truncated } = await coqlCallsWindow(
      token, fmtCOQL(new Date(fromMs)), fmtCOQL(new Date(toMs)));
    if (!truncated) return rows;
    if (toMs - fromMs <= MIN_SPAN_MS || depth > 12) {
      throw new Error(
        `Calls window ${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()} `
        + `exceeds COQL's ${COQL_OFFSET_CEILING}-record limit and cannot be split further`);
    }
    const mid = fromMs + Math.floor((toMs - fromMs) / 2);
    const [a, b] = await Promise.all([
      readSpan(fromMs, mid, depth + 1),
      readSpan(mid + 1000, toMs, depth + 1),   // +1s so the halves cannot overlap
    ]);
    return a.concat(b);
  }

  // Four 6-hour windows to start with: cheap on a normal day, and each one
  // subdivides itself if the volume warrants.
  async function oneDay(date) {
    const dayStart = nyMidnightUTC(date).getTime();
    const H6 = 6 * 60 * 60 * 1000;
    const parts = await Promise.all([0, 1, 2, 3].map(i =>
      readSpan(dayStart + i * H6, dayStart + (i + 1) * H6 - 1000)));
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

// Shared call-attribution: identical bucketing for every role, so `calls`,
// `outbound`, `inbound`, `missed`, `minutes` and `callBands` always agree.
function applyCall(person, c) {
  const secs = parseFloat(c.Call_Duration_in_seconds || 0);
  person.minutes += secs / 60;
  if (c.Call_Status === "Missed") { person.missed += 1; return; }
  if (c.Call_Type === "Inbound")  { person.inbound += 1; return; }
  person.calls += 1;
  person.outbound += 1;
  person.callBands[bandOf(secs)] += 1;
  // Counted alongside the band, not instead of it — the call is still real.
  const off = offHoursOf(c.Call_Start_Time);
  if (off && person.offHours) person.offHours[off] += 1;
}

const roundBuilder = b => ({ ...b, minutes: Math.round(b.minutes) });
const roundCloser  = c => ({
  ...c,
  minutes: Math.round(c.minutes),
  newUpfront: Math.round(c.newUpfront),
  futureUpfront: Math.round(c.futureUpfront),
  revenue: Math.round(c.newUpfront + c.futureUpfront),
});

/**
 * Build the report payload for one role over one date range.
 * Returns the exact object shape both /api/report and the pre-warm cache use.
 * Throws { notFound: true, availableRoles } if no Zoho user matches `role`.
 */
export async function buildReport({ token, allUsers, role, startDate, endDate, slot }) {
  const isCloser   = role.toLowerCase().includes("closer");
  const isTeamLead = role.toLowerCase().includes("team leader");

  // userId → teamLead lookup, so everyone gets a team lead even with zero
  // leads/deals in the period.
  const userTLMap = {};
  allUsers.forEach(u => { userTLMap[u.id] = tlFromRole(u.role?.name); });

  // ── TEAM LEADER REPORT ─────────────────────────────────────────────────────
  if (isTeamLead) {
    const tlMembers = allUsers.filter(u => {
      const r = u.role?.name || "";
      return tlFromRole(r) && (r.includes("Builder") || r.includes("Closer"));
    });

    const builderMap = {}, closerMap = {};
    tlMembers.forEach(u => {
      const tl = tlFromRole(u.role.name);
      const isC = u.role.name.includes("Closer");
      const base = { name: u.full_name, id: u.id, tlName: tl, _active: isActive(u),
        calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands(), offHours: emptyOffHours() };
      if (isC) closerMap[u.id]  = { ...base, presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
      else     builderMap[u.id] = { ...base, leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
    });

    const [calls, presHeld, closedDeals, upfrontDeals,
           leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
      fetchCallsForRange(token, startDate, endDate),
      fetchByDateRange(token, "Deals", "Owner,Team_Lead",                       startDate, endDate, "Presentation_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead", startDate, endDate, "Deal_Closed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Upfront_Amount,Team_Lead",        startDate, endDate, "Upfront_Amount_Received_Date"),
      fetchByDateRange(token, "Leads", "Owner,Team_Lead",                       startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Leads", "Owner,Team_Lead",                       startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",               startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",               startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",               startDate, endDate, "Presentation_Booked_Date"),
      fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead",               startDate, endDate, "Presentation_Completed_Date"),
    ]);

    calls.forEach(c => {
      const id = c.Owner?.id;
      const map = builderMap[id] ? builderMap : closerMap[id] ? closerMap : null;
      if (!map) return;
      applyCall(map[id], c);
    });

    leadsQL.forEach(l   => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].leads++; });
    leadsDisc.forEach(l => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].discoveries++; });
    dealsQL.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].leads++; });
    dealsDisc.forEach(d => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].discoveries++; });
    dealsPB.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presBooked++; });
    dealsPC.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presCompleted++; });

    presHeld.forEach(d    => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].presentations++; });
    closedDeals.forEach(d => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].futureUpfront += parseFloat(d.Future_Booked_Upfront||0); });
    upfrontDeals.forEach(d=> { const id=d.Owner?.id; if(closerMap[id]) { closerMap[id].dealsClosed++; closerMap[id].newUpfront += parseFloat(d.Upfront_Amount||0); } });

    const teams = {};
    ["Soham","Tejasvi","Mamta Das"].forEach(tl => {
      teams[tl] = {
        builders: rosterOf(builderMap).filter(b=>b.tlName===tl).map(roundBuilder),
        closers:  rosterOf(closerMap).filter(c=>c.tlName===tl).map(roundCloser),
      };
    });

    return { teams, startDate, endDate, slot, role };
  }

  const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));
  if (!users.length) {
    const err = new Error(`No users found matching "${role}".`);
    err.notFound = true;
    err.availableRoles = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
    throw err;
  }

  // ── CLOSER REPORT ──────────────────────────────────────────────────────────
  if (isCloser) {
    const map = {};
    users.forEach(u => {
      map[u.id] = { name: u.full_name, id: u.id, teamLead: userTLMap[u.id] || "", _active: isActive(u),
        calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands(), offHours: emptyOffHours(),
        presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
    });

    const [calls, presHeld, closedDeals, upfrontDeals] = await Promise.all([
      fetchCallsForRange(token, startDate, endDate),
      fetchByDateRange(token, "Deals", "Owner,Team_Lead",                       startDate, endDate, "Presentation_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead", startDate, endDate, "Deal_Closed_Date"),
      fetchByDateRange(token, "Deals", "Owner,Upfront_Amount,Team_Lead",        startDate, endDate, "Upfront_Amount_Received_Date"),
    ]);

    calls.forEach(c => { const id = c.Owner?.id; if (map[id]) applyCall(map[id], c); });

    presHeld.forEach(d => {
      const id = d.Owner?.id; if (!map[id]) return;
      map[id].presentations += 1;
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });
    closedDeals.forEach(d => {
      const id = d.Owner?.id; if (!map[id]) return;
      map[id].futureUpfront += parseFloat(d.Future_Booked_Upfront || 0);
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });
    upfrontDeals.forEach(d => {
      const id = d.Owner?.id; if (!map[id]) return;
      map[id].dealsClosed += 1;
      map[id].newUpfront += parseFloat(d.Upfront_Amount || 0);
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });

    return { closers: rosterOf(map).map(roundCloser), startDate, endDate, slot, role };
  }

  // ── BUILDER REPORT ─────────────────────────────────────────────────────────
  const map = {};
  users.forEach(u => {
    map[u.id] = { name: u.full_name, id: u.id, teamLead: userTLMap[u.id] || "", _active: isActive(u),
      calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, callBands: emptyBands(), offHours: emptyOffHours(),
      leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
  });

  const [calls, leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
    fetchCallsForRange(token, startDate, endDate),
    fetchByDateRange(token, "Leads", "Owner,Team_Lead",         startDate, endDate, "Qualified_Lead_Date"),
    fetchByDateRange(token, "Leads", "Owner,Team_Lead",         startDate, endDate, "Discovery_Completed_Date"),
    fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Qualified_Lead_Date"),
    fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Discovery_Completed_Date"),
    fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Booked_Date"),
    fetchByDateRange(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Completed_Date"),
  ]);

  calls.forEach(c => { const id = c.Owner?.id; if (map[id]) applyCall(map[id], c); });

  const bumpOwner   = (arr, field) => arr.forEach(r => {
    const id = r.Owner?.id; if (!map[id]) return;
    map[id][field] += 1;
    if (!map[id].teamLead && r.Team_Lead) map[id].teamLead = r.Team_Lead;
  });
  const bumpBuilder = (arr, field) => arr.forEach(r => {
    const id = r.Builder?.id; if (!id || !map[id]) return;
    map[id][field] += 1;
    if (!map[id].teamLead && r.Team_Lead) map[id].teamLead = r.Team_Lead;
  });

  bumpOwner(leadsQL,     "leads");
  bumpOwner(leadsDisc,   "discoveries");
  bumpBuilder(dealsQL,   "leads");
  bumpBuilder(dealsDisc, "discoveries");
  bumpBuilder(dealsPB,   "presBooked");
  bumpBuilder(dealsPC,   "presCompleted");

  return { builders: rosterOf(map).map(roundBuilder), startDate, endDate, slot, role };
}
