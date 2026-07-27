// Shared server-side auth check for API routes.
// Verifies the caller's Supabase session token and checks their email against
// the same allow-list enforced client-side in public/config.js. Without this,
// the client-side ALLOWED_EMAILS check is cosmetic — anyone who knows the API
// URL can call it directly with no token at all.
//
// Keep ALLOWED_EMAILS/ADMIN_EMAILS here in sync with public/config.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

export const ALLOWED_EMAILS = [
  "aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro",
  "tejasvi.p@elevateme.pro", "soham.b@elevateme.pro", "mamta.d@elevateme.pro",
  "prachit@elevateme.pro", "dhanraj.s@elevateme.pro", "prem.t@elevateme.pro",
  "meet.t@elevateme.pro",
];
export const ADMIN_EMAILS = ["aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro", "prachit@elevateme.pro"];

// Users added via Admin Panel → Manage Users (public/config.js's APP_USERS_READY
// does the equivalent merge client-side). Checked here too so a user granted
// access purely through that UI doesn't hit a hardcoded-list wall on API calls
// the way meet.t@ did — the hardcoded arrays above are only the permanent
// baseline (core admins/TLs), not the full allow-list.
async function isAppUser(email, { adminOnly } = {}) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_users?select=email,is_admin&email=eq.${encodeURIComponent(email)}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return false;
    const rows = await r.json();
    if (!rows.length) return false;
    return adminOnly ? !!rows[0].is_admin : true;
  } catch { return false; }
}

// Returns { email } for a valid, allow-listed session token, or { error } describing why not.
// Pass { adminOnly: true } to additionally require ADMIN_EMAILS (or an app_users is_admin row).
export async function requireUser(req, { adminOnly = false } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { error: "Server misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY not set" };

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return { error: "No token sent" };

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { error: `Token rejected by Supabase (${r.status})` };
  const user = await r.json();
  if (!user?.email) return { error: "No email on Supabase user" };

  const inHardcodedList = ALLOWED_EMAILS.includes(user.email);
  if (!inHardcodedList && !(await isAppUser(user.email))) {
    return { error: `Email not allow-listed: ${user.email}` };
  }
  if (adminOnly) {
    const isHardcodedAdmin = ADMIN_EMAILS.includes(user.email);
    if (!isHardcodedAdmin && !(await isAppUser(user.email, { adminOnly: true }))) {
      return { error: `Email not admin: ${user.email}` };
    }
  }

  return { email: user.email };
}
