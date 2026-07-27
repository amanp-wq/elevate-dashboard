// Shared config for every dashboard page — loaded via <script src="/config.js">
// before each page's own inline script. Centralized here because the same
// email lists and nav logic used to be copy-pasted across ~9 files with
// slightly different formatting, which is exactly how nav/permission gaps
// (missing users, missing admins) kept slipping in across sessions.

const SUPABASE_URL  = "https://ugghpsupgqycsnvssseo.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVnZ2hwc3VwZ3F5Y3NudnNzc2VvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzc1NjAsImV4cCI6MjA5NzcxMzU2MH0.8DY8CP-F3o2loh2Ierkjm1iVyA9qOXPwpzHFIqY5vZI";

const ALLOWED_EMAILS = [
  "aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro",
  "tejasvi.p@elevateme.pro", "soham.b@elevateme.pro", "mamta.d@elevateme.pro",
  "prachit@elevateme.pro", "dhanraj.s@elevateme.pro", "prem.t@elevateme.pro",
  "meet.t@elevateme.pro"
];
const ADMIN_EMAILS = ["aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro", "prachit@elevateme.pro"];
const SALES_TL_EMAILS = ["soham.b@elevateme.pro", "tejasvi.p@elevateme.pro", "mamta.d@elevateme.pro"];
const BD_TL_EMAILS = ["dhanraj.s@elevateme.pro", "prem.t@elevateme.pro"];

// Users limited to a specific subset of pages (everyone else has no entry
// here and gets the normal role-gated access). Checked both to hide nav
// links AND to hard-block direct navigation to a disallowed page's URL.
const RESTRICTED_PAGES = {
  "meet.t@elevateme.pro": ["/", "/combined.html", "/history.html"],
};
function isPageAllowed(email, path) {
  const allowed = RESTRICTED_PAGES[email];
  return !allowed || allowed.includes(path);
}

// ── DB-managed users (Admin Panel → Manage Users) ───────────────────────────
// Rows in `app_users` are merged additively into the arrays above at load
// time, so an admin can grant/restrict access from the UI without a code
// change. Every page must `await APP_USERS_READY` before checking
// ALLOWED_EMAILS/isPageAllowed — it's already wired into every page's auth
// gate. The hardcoded arrays above remain the permanent baseline (core
// admins/TLs); app_users is for everyone added afterward.
let DB_USERS = [];
const APP_USERS_READY = (async () => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_users?select=email,full_name,pages,is_admin`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }
    });
    if (!r.ok) return;
    DB_USERS = await r.json();
    DB_USERS.forEach(u => {
      if (!ALLOWED_EMAILS.includes(u.email)) ALLOWED_EMAILS.push(u.email);
      if (u.is_admin && !ADMIN_EMAILS.includes(u.email)) ADMIN_EMAILS.push(u.email);
      if (Array.isArray(u.pages) && u.pages.length) RESTRICTED_PAGES[u.email] = u.pages;
    });
  } catch { /* leave hardcoded arrays as the fallback */ }
})();

// Every page the admin can grant/restrict access to, via the Manage Users UI.
const ALL_PAGES = [
  { label: "Dashboard", href: "/" },
  { label: "Combined", href: "/combined.html" },
  { label: "History", href: "/history.html" },
  { label: "Attendance", href: "/attendance.html" },
  { label: "Funnel", href: "/funnel.html" },
  { label: "BDE", href: "/bde.html" },
  { label: "BD Scorecard", href: "/bde-scorecard.html" },
  { label: "BD Attendance", href: "/attendance-bd.html" },
  { label: "Manage Targets", href: "/manage-targets-sales.html" },
  { label: "Manage Targets (BD)", href: "/manage-targets-bd.html" },
];

// Standard role-gated nav used by every page except admin.html (which has
// its own simpler, admin-only nav).
function buildNav(email) {
  const isAdmin = ADMIN_EMAILS.includes(email);
  const currentPage = window.location.pathname;
  const pages = [
    { label: "Dashboard", href: "/" },
    { label: "Combined", href: "/combined.html" },
    { label: "History", href: "/history.html" },
    ...(isAdmin ? [{ label: "Funnel", href: "/funnel.html" }, { label: "BDE", href: "/bde.html" }, { label: "BD Scorecard", href: "/bde-scorecard.html" }] : []),
    { label: "Attendance", href: "/attendance.html" },
    ...(isAdmin || BD_TL_EMAILS.includes(email) ? [{ label: "BD Attendance", href: "/attendance-bd.html" }] : []),
    ...(isAdmin || SALES_TL_EMAILS.includes(email) ? [{ label: "Manage Targets", href: "/manage-targets-sales.html" }] : []),
    ...(isAdmin || BD_TL_EMAILS.includes(email) ? [{ label: "Manage Targets (BD)", href: "/manage-targets-bd.html" }] : []),
    ...(isAdmin ? [{ label: "Admin Panel", href: "/admin.html" }] : [])
  ].filter(p => isPageAllowed(email, p.href));
  const navEl = document.getElementById("nav-links");
  navEl.innerHTML = pages.map(p =>
    `<a href="${p.href}" class="nav-btn${(currentPage === p.href || (p.href === '/' && (currentPage === '/' || currentPage === '/index.html'))) ? ' active' : ''}">${p.label}</a>`
  ).join("");
  navEl.style.display = "flex";
}

// Sales roster shared by attendance.html and manage-targets-sales.html.
const SALES_TEAM_MEMBERS = [
  // Team Soham
  { name: "Yashraj Modasara",  team: "Soham",     role: "Builder" },
  { name: "Aryan Sharma",      team: "Soham",     role: "Builder" },
  { name: "Dhruvil Chauhan",   team: "Soham",     role: "Builder" },
  { name: "Avni Gajjar",       team: "Soham",     role: "Builder" },
  { name: "Maharshi Patel",    team: "Soham",     role: "Builder" },
  { name: "Harsh Bhojak",      team: "Soham",     role: "Closer"  },
  { name: "Nikunj Patel",      team: "Soham",     role: "Closer"  },
  // Team Tejasvi
  { name: "Lekhraj Prajapati", team: "Tejasvi",   role: "Builder" },
  { name: "Nupur Vyas",        team: "Tejasvi",   role: "Builder" },
  { name: "Yash Mishra",       team: "Tejasvi",   role: "Closer"  },
  { name: "Kartik Deshawar",   team: "Tejasvi",   role: "Closer"  },
  { name: "Abhijeet Das",      team: "Tejasvi",   role: "Closer"  },
  // Team Mamta Das
  { name: "Shivam Rathi",      team: "Mamta Das", role: "Builder" },
  { name: "Soumya Singh",      team: "Mamta Das", role: "Builder" },
  { name: "Nishant Sharma",    team: "Mamta Das", role: "Builder" },
  { name: "Pranali Mishra",    team: "Mamta Das", role: "Closer"  },
  { name: "Meet Patel",        team: "Mamta Das", role: "Closer"  },
  { name: "Vidhi Patel",       team: "Mamta Das", role: "Closer"  },
];
// email -> Sales team name this TL manages (used by manage-targets-sales.html)
const SALES_TL_TEAM = {
  "soham.b@elevateme.pro": "Soham",
  "tejasvi.p@elevateme.pro": "Tejasvi",
  "mamta.d@elevateme.pro": "Mamta Das",
};

// BD roster shared by attendance-bd.html and manage-targets-bd.html.
// Two different real people are both named "Meet Patel" (a Closer under
// Mamta Das above, and the BD Referral member here) — the BD one is keyed
// distinctly wherever it's stored so it never collides with the Closer's data.
const BD_PERSON_KEY_OVERRIDES = { "Meet Patel": "Meet Patel (BD)" };
const bdPersonKey = m => BD_PERSON_KEY_OVERRIDES[m] || m;
const BD_TEAM_MEMBERS = [
  { name: "Ronak Khant",           team: "Dhanraj Solanki", role: "BD" },
  { name: "Jiya Chandrawanshi",    team: "Dhanraj Solanki", role: "BD" },
  { name: "Bhoomi Barot",          team: "Dhanraj Solanki", role: "BD" },
  { name: "Sunil Patel",           team: "Dhanraj Solanki", role: "BD" },
  { name: "Meet Patel (BD)", display: "Meet Patel", team: "Dhanraj Solanki", role: "BD" },
  { name: "Heer Nakum",  team: "Prem Thakar", role: "BD" },
  { name: "Ajay Darbar", team: "Prem Thakar", role: "BD" },
];
