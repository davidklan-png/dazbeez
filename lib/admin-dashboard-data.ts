// ---------------------------------------------------------------------------
// Admin Dashboard – typed seed data
// Framework-agnostic. The page layer imports these exports and passes them
// as props to the presentation component.
// ---------------------------------------------------------------------------

// ---- Types ----------------------------------------------------------------

export interface KpiCard {
  label: string;
  value: string;
  change: string; // e.g. "+12%"
  trend: "up" | "down" | "flat";
}

export interface ServiceInterest {
  name: string;
  count: number;
  /** Percentage 0-100 for visual bar width */
  percent: number;
}

export type LeadStatus = "new" | "contacted" | "proposal" | "won" | "lost";

export interface LeadRow {
  company: string;
  contact: string;
  service: string;
  status: LeadStatus;
  value: string;
}

export interface ActivityItem {
  id: number;
  text: string;
  time: string;
}

export interface ActionItem {
  id: number;
  text: string;
  priority: "high" | "medium" | "low";
}

// ---- Seed data ------------------------------------------------------------

export const dashboardLastUpdated = "April 12, 2026";

export const dashboardKpis: KpiCard[] = [
  { label: "Total Inquiries", value: "147", change: "+12%", trend: "up" },
  { label: "Active Leads", value: "23", change: "+3", trend: "up" },
  { label: "Conversion Rate", value: "18%", change: "-2%", trend: "down" },
  { label: "Revenue (Q1)", value: "$42k", change: "+8%", trend: "up" },
];

const serviceInterestCounts = [
  { name: "AI Integration", count: 52 },
  { name: "Automation", count: 38 },
  { name: "Data Management", count: 28 },
  { name: "Governance", count: 18 },
  { name: "Project Management", count: 11 },
] as const;

const maxServiceInterestCount = Math.max(
  ...serviceInterestCounts.map((service) => service.count),
);

export const serviceInterestBreakdown: ServiceInterest[] = serviceInterestCounts.map(
  (service) => ({
    ...service,
    percent: Math.round((service.count / maxServiceInterestCount) * 100),
  }),
);

export const leadPipeline: LeadRow[] = [
  { company: "Acme Corp", contact: "Jane Smith", service: "AI Integration", status: "proposal", value: "$12k" },
  { company: "TechStart LLC", contact: "Bob Chen", service: "Automation", status: "contacted", value: "$8k" },
  { company: "DataDrive Inc", contact: "Sara Lee", service: "Data Management", status: "new", value: "$6k" },
  { company: "GlobalFin", contact: "Mike Ross", service: "Governance", status: "won", value: "$15k" },
  { company: "RetailMax", contact: "Amy Wu", service: "AI Integration", status: "lost", value: "$10k" },
];

export const recentActivity: ActivityItem[] = [
  { id: 1, text: "New inquiry from Acme Corp – AI Integration", time: "2h ago" },
  { id: 2, text: "Proposal sent to TechStart LLC", time: "5h ago" },
  { id: 3, text: "DataDrive Inc signed up for newsletter", time: "1d ago" },
  { id: 4, text: "Follow-up call with GlobalFin scheduled", time: "1d ago" },
  { id: 5, text: "RetailMax deal marked lost – no response", time: "2d ago" },
];

export const pendingActions: ActionItem[] = [
  { id: 1, text: "Send proposal to DataDrive Inc", priority: "high" },
  { id: 2, text: "Follow up with TechStart LLC", priority: "medium" },
  { id: 3, text: "Update CRM with Q1 revenue figures", priority: "low" },
];
