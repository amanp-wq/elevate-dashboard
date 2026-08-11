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
// The guide is documentation about pages the user can already see, so it is
// never worth restricting — a page-limited user still needs to understand how
// their own numbers are calculated.
const ALWAYS_ALLOWED_PAGES = ["/guide.html"];
function isPageAllowed(email, path) {
  if (ALWAYS_ALLOWED_PAGES.includes(path)) return true;
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
  { label: "TV Board", href: "/tv-board.html" },
  { label: "TV Slides", href: "/manage-slides.html" },
];

// Dropdown-nav styling is injected from here rather than added to each
// page's own <style> block — buildNav() is shared by ~11 pages, and
// keeping the markup and its CSS in one file is what stops them drifting
// apart (the same drift that caused the earlier toolbar-alignment bug).
// Fallback values are given for every var because history.html and
// bde-scorecard.html don't define --accent.
function injectNavStyles() {
  if (document.getElementById("nav-dropdown-styles")) return;
  const css = `
    .nav-group { position: relative; display: inline-flex; }
    .nav-group > .nav-btn { cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
    .nav-caret { font-size: 8px; line-height: 1; transition: transform 0.2s; }
    .nav-group.open .nav-caret { transform: rotate(180deg); }
    .nav-menu {
      display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 1000;
      min-width: 190px; padding: 6px; border-radius: 12px;
      background: #0f1322; border: 1px solid var(--border, #1e2640);
      box-shadow: 0 12px 32px rgba(0,0,0,0.55);
    }
    .nav-group.open .nav-menu { display: block; }
    .nav-menu a {
      display: block; padding: 8px 12px; border-radius: 8px; white-space: nowrap;
      font-size: 12px; font-weight: 600; color: var(--muted, #6b7499); text-decoration: none;
      transition: background 0.15s, color 0.15s;
    }
    .nav-menu a:hover { background: rgba(255,255,255,0.06); color: var(--accent, #ff4d3a); }
    .nav-menu a.active { background: var(--accent, #ff4d3a); color: #fff; }
    @media (max-width: 768px) { .nav-menu { min-width: 160px; } .nav-menu a { font-size: 11px; padding: 7px 10px; } }
  `;
  const el = document.createElement("style");
  el.id = "nav-dropdown-styles";
  el.textContent = css;
  document.head.appendChild(el);
}

// Standard role-gated nav used by every page except admin.html (which has
// its own simpler, admin-only nav). Related pages are grouped into
// dropdowns so the bar stays short instead of running 12 buttons wide.
function buildNav(email) {
  const isAdmin = ADMIN_EMAILS.includes(email);
  const isSalesTL = SALES_TL_EMAILS.includes(email);
  const isBdTL = BD_TL_EMAILS.includes(email);
  const currentPage = window.location.pathname;
  const isCurrent = href =>
    currentPage === href || (href === "/" && (currentPage === "/" || currentPage === "/index.html"));

  // A `group` renders as a dropdown; a bare item renders as a plain button.
  // Groups whose children are all filtered out are dropped entirely, so a
  // page-restricted user never sees an empty dropdown.
  const nav = [
    { label: "Dashboard", href: "/" },
    { label: "Combined", href: "/combined.html" },
    { label: "History", href: "/history.html" },
    { group: "BD", items: [
      ...(isAdmin ? [{ label: "Funnel", href: "/funnel.html" }, { label: "BDE", href: "/bde.html" }, { label: "BD Scorecard", href: "/bde-scorecard.html" }] : []),
    ]},
    { group: "Attendance", items: [
      { label: "Sales Attendance", href: "/attendance.html" },
      ...(isAdmin || isBdTL ? [{ label: "BD Attendance", href: "/attendance-bd.html" }] : []),
    ]},
    { group: "Targets", items: [
      ...(isAdmin || isSalesTL ? [{ label: "Sales Targets", href: "/manage-targets-sales.html" }] : []),
      ...(isAdmin || isBdTL ? [{ label: "BD Targets", href: "/manage-targets-bd.html" }] : []),
    ]},
    // "TV Slides" manages the promo slides on the *test* TV board, which is the
    // only one that shows them — the live TV board deliberately has no slide
    // rotation. The page itself spells that out so the link isn't misleading.
    { group: "TV", items: [
      ...(isAdmin ? [{ label: "TV Board", href: "/tv-board.html" }, { label: "TV Slides", href: "/manage-slides.html" }] : []),
    ]},
    ...(isAdmin ? [{ label: "Admin Panel", href: "/admin.html" }] : []),
    // Visible to everyone — it explains how their own numbers are calculated.
    { label: "Guide", href: "/guide.html" },
  ];

  const visible = nav
    .map(entry => entry.group
      ? { ...entry, items: entry.items.filter(i => isPageAllowed(email, i.href)) }
      : entry)
    .filter(entry => entry.group ? entry.items.length > 0 : isPageAllowed(email, entry.href));

  injectNavStyles();
  const navEl = document.getElementById("nav-links");
  navEl.innerHTML = visible.map(entry => {
    if (!entry.group) {
      return `<a href="${entry.href}" class="nav-btn${isCurrent(entry.href) ? " active" : ""}">${entry.label}</a>`;
    }
    // A group with a single surviving child is pointless as a dropdown —
    // render it as a normal button straight to that page.
    if (entry.items.length === 1) {
      const only = entry.items[0];
      return `<a href="${only.href}" class="nav-btn${isCurrent(only.href) ? " active" : ""}">${only.label}</a>`;
    }
    const groupActive = entry.items.some(i => isCurrent(i.href));
    const links = entry.items.map(i =>
      `<a href="${i.href}"${isCurrent(i.href) ? ' class="active"' : ""}>${i.label}</a>`
    ).join("");
    return `<div class="nav-group">
      <button type="button" class="nav-btn${groupActive ? " active" : ""}">${entry.group}<span class="nav-caret">▼</span></button>
      <div class="nav-menu">${links}</div>
    </div>`;
  }).join("");
  navEl.style.display = "flex";

  navEl.querySelectorAll(".nav-group > .nav-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const group = btn.parentElement;
      const wasOpen = group.classList.contains("open");
      navEl.querySelectorAll(".nav-group.open").forEach(g => g.classList.remove("open"));
      if (!wasOpen) group.classList.add("open");
    });
  });
  document.addEventListener("click", () => {
    navEl.querySelectorAll(".nav-group.open").forEach(g => g.classList.remove("open"));
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") navEl.querySelectorAll(".nav-group.open").forEach(g => g.classList.remove("open"));
  });
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
