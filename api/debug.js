export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

  try {
    const tr = await fetch("https://accounts.zoho.in/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const td = await tr.json();
    if (!td.access_token) return res.status(500).json({ error: "Auth failed", detail: td });
    const token = td.access_token;

    const date = req.query.date || "2026-06-16";

    const h = { Authorization: `Zoho-oauthtoken ${token}` };

    // Try different criteria formats for date fields
    const tests = await Promise.all([
      // Format 1: equals with yyyy-MM-dd
      fetch(`https://www.zohoapis.in/crm/v2/Leads?criteria=(Qualified_Lead_Date:equals:${date})&fields=Owner,Qualified_Lead_Date&per_page=5`, {headers:h}).then(r=>r.json()),
      // Format 2: between with yyyy-MM-dd
      fetch(`https://www.zohoapis.in/crm/v2/Leads?criteria=(Qualified_Lead_Date:between:${date},${date})&fields=Owner,Qualified_Lead_Date&per_page=5`, {headers:h}).then(r=>r.json()),
      // Format 3: search endpoint equals
      fetch(`https://www.zohoapis.in/crm/v2/Leads/search?criteria=(Qualified_Lead_Date:equals:${date})&fields=Owner,Qualified_Lead_Date&per_page=5`, {headers:h}).then(r=>r.json()),
      // Format 4: calls raw last 5
      fetch(`https://www.zohoapis.in/crm/v2/Calls?fields=Owner,Duration_in_minutes,Call_Start_Time&per_page=5&sort_by=Call_Start_Time&sort_order=desc`, {headers:h}).then(r=>r.json()),
      // Format 5: calls with criteria
      fetch(`https://www.zohoapis.in/crm/v2/Calls?criteria=(Call_Start_Time:between:${date}T00:00:00-05:00,${date}T23:59:59-05:00)&fields=Owner,Duration_in_minutes,Call_Start_Time&per_page=5`, {headers:h}).then(r=>r.json()),
    ]);

    return res.status(200).json({
      date_tested: date,
      leads_equals:        { count: tests[0]?.data?.length || 0, error: tests[0]?.message, sample: tests[0]?.data?.[0]?.Qualified_Lead_Date },
      leads_between:       { count: tests[1]?.data?.length || 0, error: tests[1]?.message, sample: tests[1]?.data?.[0]?.Qualified_Lead_Date },
      leads_search_equals: { count: tests[2]?.data?.length || 0, error: tests[2]?.message, sample: tests[2]?.data?.[0]?.Qualified_Lead_Date },
      calls_raw_last5:     { count: tests[3]?.data?.length || 0, sample_time: tests[3]?.data?.[0]?.Call_Start_Time },
      calls_with_criteria: { count: tests[4]?.data?.length || 0, error: tests[4]?.message },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
