# ElevateMe Performance Dashboard

Sales-floor performance reporting for ElevateMe, built on Zoho CRM data.
Scores every Builder, Closer and BD executive against daily KPI targets, and
puts the result on a dashboard, a set of drill-down pages, and a 1920×1080
floor TV board.

**Live:** https://elevate-dashboard-iota.vercel.app

---

## Stack

| | |
|---|---|
| **Hosting** | Vercel — auto-deploys on push to `main` |
| **Frontend** | Plain HTML + vanilla JS. No framework, no build step. Each page is one self-contained `.html` file that loads two shared scripts. |
| **API** | Vercel serverless functions in `api/` (ESM, `maxDuration: 300`) |
| **Data source** | Zoho CRM (India DC — `accounts.zoho.in`), queried over COQL |
| **Auth** | Supabase Auth, Google OAuth only |
| **Storage** | Two Supabase projects — see [Data](#data) |

There is no `npm install` and no bundler. Open a page, it runs. That is
deliberate: the team edits these files directly.

---

## Repo layout

```
public/
  config.js              Shared: Supabase clients' constants, rosters, auth gate,
                         nav, target overrides, holiday list. Loaded by every page.
  scoring.js             Shared: the entire scoring model. Pure functions, no I/O.

  index.html             Dashboard — the main report, per person, for a date range
  combined.html          Builders + Closers side by side
  history.html           Day-by-day history from daily_kpi snapshots
  funnel.html            Lead funnel: generated → assigned → … → closed won
  bde.html               BD lead-generation dashboard
  bde-scorecard.html     BD scorecard — per-BDE KPI cards with funnel conversion
  attendance.html        Sales attendance (leave marking)
  attendance-bd.html     BD attendance
  tv-board.html          Floor TV board — 4 rotating views, fixed 1920×1080 canvas
  guide.html             Explains to staff how their own score is calculated
  admin.html             Admin panel — users, access, activity
  manage-targets.html    Per-person target and weight overrides (sales + BD)
  manage-targets-sales.html / manage-targets-bd.html
  manage-slides.html     Upload/reorder the TV board's promo slides
  manage-holidays.html   Tick which holidays close the floor
  photos/                Per-person avatars, <slug>.png or .jfif

api/
  report.js              Builder/Closer report for a date range (the main endpoint)
  bde.js                 BD lead-generation data
  funnel.js              Funnel stage counts
  refresh.js             Warms report_cache; also the cron entry point
  admin.js               User management + activity logging
  debug.js               Diagnostics
  _lib/auth.js           requireUser() — verifies the Supabase JWT
  _lib/report-core.js    Zoho COQL queries and report assembly (the heavy lifting)
```

---

## Data

### Zoho CRM

Queried via COQL with a refresh-token OAuth flow. Access tokens are cached in
memory for 50 minutes to stay under rate limits.

Modules: **Leads**, **Contacts**, **Deals**. A person's work is spread across
all three — a lead that converts becomes a Contact and then a Deal, so counting
only Leads undercounts badly.

Date fields that drive the KPIs:

```
Qualified_Lead_Date          Discovery_Completed_Date
Presentation_Booked_Date     Presentation_Completed_Date
Deal_Closed_Date             Upfront_Amount_Received_Date
```

**COQL has a hard 2,000-record ceiling per query.** Any query that can exceed
it must be split — by time window, recursively if needed. Ignoring this is how
August's call counts came out ~18% low.

### Supabase — two projects

| Project | Ref | Holds |
|---|---|---|
| **App** | `ugghpsupgqycsnvssseo` | `app_users`, `attendance`, `kpi_target_overrides`, `report_cache`, `user_activity`, `api_logs` |
| **Snapshot** | `czfsjrvngiojjjevmvtz` | `daily_kpi`, `holidays`, `tv_slides` |

The snapshot project is shared with the test deploy
(`elevate-dashboard-testa.vercel.app`), which is where the daily snapshot cron
actually runs. **Live history therefore depends on the test project staying
up.** This is a known wart, not a design choice.

| Table | What it is |
|---|---|
| `daily_kpi` | One finished row per person per day: raw KPIs, score, zone, on_leave. Written by the snapshot cron. Weekends only carry rows for people who actually worked. |
| `holidays` | `date`, `name`, `closes_floor`, `note`. Only `closes_floor = true` rows affect scoring. |
| `kpi_target_overrides` | Per-person **monthly** targets and weights. `person_key`, `kpi_label`, `month`, `monthly_target`. A `w:` prefix on the label means it is a weight, not a target. |
| `attendance` | Leave marking, per person per day |
| `report_cache` | 20-minute cache of assembled reports, keyed by range + filters |
| `tv_slides` | Promo slides for the TV board, pointing at Storage |

---

## The scoring model

All of it lives in `public/scoring.js`. Nothing else should reimplement it.

### Daily targets and weights

```js
Builder: calls 150, minutes 180, leads 4, discoveries 2, presBooked 2, presCompleted 2
         weights 0.20 / 0.20 / 0.10 / 0.15 / 0.10 / 0.25

Closer:  calls 60, minutes 120, presentations 2
         weights 0.40 / 0.20 / 0.40
```

Each KPI is scored `min(150, actual / target × 100)` — capped at 150 so one
runaway metric cannot carry a bad week — then weighted and summed.

### Closers: the deal multiplier

A closer's weighted score is then adjusted by deals closed:

```
2+ deals → clamp(score × 1.50, 110, 150)
1 deal   → clamp(score × 1.25,  95, 125)
0 deals  → min(score, 110)
```

A closer with no calls **and** no deals is Red regardless of the arithmetic.

### Zones (the "cards")

```
110+  gold      95–109  green      75–94  yellow      50–74  orange      <50  red
```

### Period targets

A target is a **daily rate × working days in the range**. Working days come
from `totalDayFraction()`, which returns 0 for weekends, 0 for holidays that
close the floor, and a fraction for today (prorated across a 10:30–19:30 ET
working day).

> **The single most common bug in this codebase** is passing an
> already-multiplied period target where a daily rate is expected, which
> squares the day count. It has shipped twice. If a score looks impossibly low
> on a multi-day range, check this first.

### Overrides

Stored as **monthly** figures and divided by `WORKING_DAYS_PER_MONTH = 22` to
get a daily rate. That 22 is a fixed constant, not the month's real weekday
count — `manage-targets.html` surfaces the resulting gap rather than silently
changing everyone's numbers.

A range spanning two months resolves to one month via `dominantMonth()`: the
month holding the most **working** days wins, ties go to the earlier month.

### Holidays

`holidays` rows marked `closes_floor` are loaded at startup and handed to
`Scoring.setClosedDays()`. `isNonWorkingDay()` = weekend **or** closed holiday,
and that is what `dayFraction()` gates on. `isWeekend()` still means only a
weekend — callers ask it that question specifically.

Work done on a closed holiday still counts toward actuals. The day simply
carries no target.

**Not every listed holiday closes the floor.** 3 July 2026 is on the calendar
and took 717 calls across 13 people. That is why there is a `closes_floor`
flag rather than a plain date list.

---

## Auth and permissions

Google OAuth via Supabase. Three layers:

1. `ALLOWED_EMAILS` — who can sign in at all
2. `ADMIN_EMAILS` — who sees admin pages
3. `RESTRICTED_PAGES` — per-email page whitelist, enforced both in the nav and
   on direct URL navigation

Baselines live in `config.js`; rows in `app_users` are merged in additively at
load time so access can be changed from the Admin Panel without a deploy.

**Every page must `await APP_USERS_READY` before checking any of these.**

---

## Environment variables

Set in Vercel, not in the repo:

```
ZOHO_CLIENT_ID          ZOHO_CLIENT_SECRET       ZOHO_REFRESH_TOKEN
SUPABASE_URL            SUPABASE_ANON_KEY
CRON_SECRET             # gates api/refresh.js; unset means that path is closed
```

---

## Conventions that will bite you

These are all real failures this codebase has already had. They read as
nitpicks; each one took a page down.

**Every page creates its own Supabase client.** `const _supabase =
supabase.createClient(SUPABASE_URL, SUPABASE_ANON);` — there is no shared one.
A new page assembled from another page's parts will silently omit it and fail
only inside the auth gate.

**`scoring.js` is not loaded everywhere.** If a page uses `Scoring.*`, it must
have `<script src="/scoring.js">`. Two BD pages did not, and routing their
working-day counter through `Scoring` broke both.

**`await HOLIDAYS_READY` before counting working days.** Otherwise the first
render prices a closed holiday as a full day and every number jumps when the
fetch lands.

**BD KPI definitions are duplicated in three files** — `bde-scorecard.html`,
`tv-board.html`, and the test repo's board. They must agree. This is the single
largest source of "fixed it, but only in one place".

**The TV board is a fixed 1920×1080 canvas** scaled to the viewport. Its inner
grid needs an explicit `grid-template-columns: minmax(0,1fr)` — without it the
implicit `auto` column sizes to content min-content and the whole board hangs
off the right edge. Flex bands inside cards need `flex:none` or they shrink
below their own content and overlap.

**Line endings are CRLF** in most files. Patch scripts that assume LF will not
match.

**Reports are point-in-time.** Zoho's financial date fields are immutable, but
lead type and BDE attribution are not — a CSV exported today will not reproduce
a report run last month.

---

## Making common changes

| Want to | Edit |
|---|---|
| Change a KPI target or weight globally | `public/scoring.js` → `TARGETS` / `WEIGHTS` |
| Change one person's target | Use `/manage-targets.html`, not code |
| Add or move a team member | `SALES_TEAM_MEMBERS` / `BD_TEAM_MEMBERS` in `config.js` |
| Mark a holiday | Use `/manage-holidays.html` |
| Change zone thresholds | `zone()` in `scoring.js` |
| Add a page | Copy an existing page's `<head>`, auth gate **and client creation**; add it to `ALL_PAGES` in `config.js` |
| Change what the TV board shows | `render()` in `tv-board.html` — one function per view |
| Add a Zoho field | `api/_lib/report-core.js` — mind the 2,000-record ceiling |

---

## Related repos

- **`elevate-dashboard-testa`** (`sharmajhanvi450-ui`) — the test deploy. Same
  TV board, no login, plus promo slides and the daily snapshot cron.
- **`elevateme-jobs`** — job-application automation, unrelated
- **`elevatemelms`** — the LMS, unrelated
