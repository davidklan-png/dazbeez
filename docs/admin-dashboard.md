# Admin Dashboard

## Overview

The `/admin` route provides an internal operations dashboard for monitoring business KPIs, lead pipeline, service interest, recent activity, and pending actions.

- **Route:** `/admin`
- **Access:** Not publicly linked. `robots: noindex, follow: false` prevents search indexing.
- **Rendering:** Server component — data is fetched at build/request time, no client-side JavaScript for data loading
- **Auth:** None currently (relies on obscurity + noindex). Add auth before exposing to any network.

---

## Architecture

```
app/admin/page.tsx         ← Server component (metadata + data wiring)
  ↓ imports
lib/admin-dashboard-data.ts  ← Typed seed data (KPIs, leads, activity)
  ↓ passed as props to
components/admin/admin-dashboard.tsx  ← Pure presentation component
```

This separation makes the dashboard trivially testable and swappable — replace the seed data with a real data source (DB, API) in `page.tsx` without touching the UI component.

---

## Data Model

All types are defined in `lib/admin-dashboard-data.ts`.

### `KpiCard`

```typescript
interface KpiCard {
  label: string;   // "Total Inquiries"
  value: string;   // "147"
  change: string;  // "+12%"
  trend: "up" | "down" | "flat";
}
```

Rendered with trend color: green (up), red (down), gray (flat).

### `ServiceInterest`

```typescript
interface ServiceInterest {
  name: string;    // "AI Integration"
  count: number;   // 52
  percent: number; // 0-100, relative to max count
}
```

Percent is calculated as `Math.round((count / maxCount) * 100)` — not absolute.

### `LeadRow`

```typescript
interface LeadRow {
  company: string;
  contact: string;
  service: string;
  status: "new" | "contacted" | "proposal" | "won" | "lost";
  value: string;  // "$12k"
}
```

### `ActivityItem`

```typescript
interface ActivityItem {
  id: number;
  text: string;  // "New inquiry from Acme Corp"
  time: string;  // "2h ago"
}
```

### `ActionItem`

```typescript
interface ActionItem {
  id: number;
  text: string;
  priority: "high" | "medium" | "low";
}
```

---

## Seed Data (Current Values)

**Last updated:** April 12, 2026

### KPIs

| Label | Value | Change | Trend |
|-------|-------|--------|-------|
| Total Inquiries | 147 | +12% | up |
| Active Leads | 23 | +3 | up |
| Conversion Rate | 18% | -2% | down |
| Revenue (Q1) | $42k | +8% | up |

### Service Interest

| Service | Count | Bar % |
|---------|-------|-------|
| AI Integration | 52 | 100% |
| Automation | 38 | 73% |
| Data Management | 28 | 54% |
| Governance | 18 | 35% |
| Project Management | 11 | 21% |

### Lead Pipeline

| Company | Contact | Service | Status | Value |
|---------|---------|---------|--------|-------|
| Acme Corp | Jane Smith | AI Integration | proposal | $12k |
| TechStart LLC | Bob Chen | Automation | contacted | $8k |
| DataDrive Inc | Sara Lee | Data Management | new | $6k |
| GlobalFin | Mike Ross | Governance | won | $15k |
| RetailMax | Amy Wu | AI Integration | lost | $10k |

---

## Component Reference

### `AdminDashboard` props

```typescript
interface AdminDashboardProps {
  kpis: KpiCard[];
  services: ServiceInterest[];
  leads: LeadRow[];
  activity: ActivityItem[];
  actions: ActionItem[];
  lastUpdatedLabel: string;
}
```

### Layout

```
Header (title + last updated label)
  ↓
KPI Cards (4-col grid, sm:2-col)
  ↓
[Service Interest bar chart] [Lead Pipeline table]  ← 2-col on lg
  ↓
[Recent Activity feed]       [Pending Actions list]  ← 2-col on lg
```

### Status Badge Colors

| Status | Background | Text |
|--------|-----------|------|
| `new` | `blue-100` | `blue-700` |
| `contacted` | `amber-100` | `amber-700` |
| `proposal` | `purple-100` | `purple-700` |
| `won` | `green-100` | `green-700` |
| `lost` | `red-100` | `red-700` |

### Priority Indicator Dots

| Priority | Color |
|----------|-------|
| `high` | `bg-red-500` |
| `medium` | `bg-amber-500` |
| `low` | `bg-green-500` |

---

## Connecting Live Data

To replace seed data with real sources, update `app/admin/page.tsx`:

```typescript
// Example: fetch from a local JSON file or SQLite
import { readDashboardData } from "@/lib/data-sources/dashboard";

export default async function AdminPage() {
  const { kpis, leads, activity, actions, services } = await readDashboardData();
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <AdminDashboard ... />
    </div>
  );
}
```

The `AdminDashboard` component requires no changes — it is purely presentational.

---

## Security Notes

- The route has no authentication. It is protected only by:
  1. Not being linked from any public page
  2. `robots: noindex` preventing search engine indexing
- **Before exposing to any public or shared network**, add authentication (e.g. middleware-based Basic Auth or NextAuth.js)
- Consider IP allowlisting via Cloudflare Access if the site is public
