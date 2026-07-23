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
];
export const ADMIN_EMAILS = ["aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro", "prachit@elevateme.pro"];

// Returns { email } for a valid, allow-listed session token, or null.
// Pass { adminOnly: true } to additionally require ADMIN_EMAILS membership.
export async function requireUser(req, { adminOnly = false } = {}) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user?.email) return null;
  if (!ALLOWED_EMAILS.includes(user.email)) return null;
  if (adminOnly && !ADMIN_EMAILS.includes(user.email)) return null;

  return { email: user.email };
}
