import type { ServiceSlug } from "@/lib/services";

export const serviceAccentColors: Record<ServiceSlug, string> = {
  ai: "#F59E0B",
  automation: "#F97316",
  data: "#CA8A04",
  governance: "#57534E",
  pm: "#B45309",
};

export const serviceIllustrations: Partial<Record<ServiceSlug, string>> = {
  ai: "/illustrations/service-ai.svg",
  automation: "/illustrations/service-automation.svg",
  data: "/illustrations/service-data.svg",
  governance: "/illustrations/service-governance.svg",
  pm: "/illustrations/service-pm.svg",
};
