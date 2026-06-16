export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
  const AUTH_DOMAIN   = "https://accounts.zoho.in";
  const API_DOMAIN    = "https://www.zohoapis.in";

  async function getAccessToken() {
    const r = await fetch(`${AUTH_DOMAIN}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
    return data.access_token;
  }

  async function zohoGet(token, url) {
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    return r.json();
  }

  async function fetchAllPages(token, module, dateField, date) {
    let all = [], page = 1;
    while (true) {
      const url = `${API_DOMAIN}/crm/v2/${module}?fields=Owner,Builder,Qualified_Lead_Date,Discovery_Completed_Date,Presentation_Booked_Date,Team_Lead&criteria=(${dateField}:equals:${date})&per_page=200&page=${page}`;
      const data = await zohoGet(token, url);
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      page++;
    }
    return all;
  }

  try {
    const { date, slot, role } = req.method === "POST" ? req.body : req.query;
    if (!date || !slot || !role) return res.status(400).json({ error: "Missing date, slot or role" });

    const token = await getAccessToken();

    // Fetch only ActiveUsers — fastest single call
    const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
    const allUsers = ud?.users || [];

    const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));

    if (!users.length) {
      const roleNames = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
      return res.status(404).json({
        error: `No users found matching "${role}".`,
        available_roles: roleNames,
        total_fetched: allUsers.length
      });
    }

    const map = {};
    users.forEach(u => {
      map[u.id] = { name: u.full_name, id: u.id, teamLead: "", calls: 0, minutes: 0, leads: 0, discoveries: 0, presentations: 0 };
    });

    // Run all data fetches in parallel for speed
    const [callsData, leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPres] = await Promise.all([
      zohoGet(token, `${API_DOMAIN}/crm/v2/Calls?fields=Owner,Duration_in_minutes,Call_Start_Time&criteria=(Call_Start_Time:between:${date}T00:00:00-05:00,${date}T23:59:59-05:00)&per_page=200`),
      fetchAllPages(token, "Leads", "Qualified_Lead_Date", date),
      fetchAllPages(token, "Leads", "Discovery_Completed_Date", date),
      fetchAllPages(token, "Deals", "Qualified_Lead_Date", date),
      fetchAllPages(token, "Deals", "Discovery_Completed_Date", date),
      fetchAllPages(token, "Deals", "Presentation_Booked_Date", date),
    ]);

    // Calls
    (callsData?.data || []).forEach(c => {
      const id = c.Owner?.id;
      if (map[id]) { map[id].calls += 1; map[id].minutes += parseFloat(c.Duration_in_minutes || 0); }
    });

    // Leads - qualified
    leadsQL.forEach(l => {
      const id = l.Owner?.id;
      if (map[id]) { map[id].leads += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
    });

    // Leads - discovery
    leadsDisc.forEach(l => {
      const id = l.Owner?.id;
      if (map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
    });

    // Deals - qualified leads
    dealsQL.forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].leads += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    // Deals - discovery
    dealsDisc.forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    // Deals - presentations booked
    dealsPres.forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].presentations += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    return res.status(200).json({ builders, date, slot, role });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
