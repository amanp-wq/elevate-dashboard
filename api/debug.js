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

    // Test 1: Fetch last 5 calls with NO date filter to see raw data + timezone format
    const callsRaw = await fetch("https://www.zohoapis.in/crm/v2/Calls?fields=Owner,Duration_in_minutes,Call_Start_Time&per_page=5&sort_by=Call_Start_Time&sort_order=desc", {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const callsData = await callsRaw.json();

    // Test 2: Fetch last 5 leads with NO date filter
    const leadsRaw = await fetch("https://www.zohoapis.in/crm/v2/Leads?fields=Owner,Qualified_Lead_Date,Discovery_Completed_Date,Team_Lead&per_page=5&sort_by=Modified_Time&sort_order=desc", {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const leadsData = await leadsRaw.json();

    // Test 3: Fetch last 5 deals
    const dealsRaw = await fetch("https://www.zohoapis.in/crm/v2/Deals?fields=Owner,Builder,Qualified_Lead_Date,Discovery_Completed_Date,Presentation_Booked_Date,Team_Lead&per_page=5&sort_by=Modified_Time&sort_order=desc", {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const dealsData = await dealsRaw.json();

    return res.status(200).json({
      sample_calls: (callsData?.data || []).map(c => ({
        owner: c.Owner?.name,
        Call_Start_Time: c.Call_Start_Time,
        duration: c.Duration_in_minutes
      })),
      sample_leads: (leadsData?.data || []).map(l => ({
        owner: l.Owner?.name,
        Qualified_Lead_Date: l.Qualified_Lead_Date,
        Discovery_Completed_Date: l.Discovery_Completed_Date
      })),
      sample_deals: (dealsData?.data || []).map(d => ({
        builder: d.Builder?.name,
        owner: d.Owner?.name,
        Qualified_Lead_Date: d.Qualified_Lead_Date,
        Discovery_Completed_Date: d.Discovery_Completed_Date,
        Presentation_Booked_Date: d.Presentation_Booked_Date
      }))
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
