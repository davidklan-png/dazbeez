export interface NfcCardMetric {
  token: string;
  label: string;
  tap_count: number;
  contact_count: number;
  conversion_rate: number;
}

export interface NfcContactRow {
  id: number;
  token: string;
  name: string;
  email: string;
  source: "google" | "linkedin" | "manual";
  sources: Array<"google" | "linkedin" | "manual">;
  company: string | null;
  linkedin_url: string | null;
  cf_country: string | null;
  cf_city: string | null;
  created_at: string;
}

export interface NfcContactEventRow {
  id: number;
  contact_id: number;
  token: string;
  source: "google" | "linkedin" | "manual";
  name: string;
  email: string;
  created_at: string;
}

export interface NfcVCardProfile {
  fileName: string;
  familyName: string;
  givenName: string;
  fullName: string;
  organization: string;
  title: string;
  email: string;
  website: string;
  linkedin: string;
}

export type NfcAdminPanelData =
  | {
      status: "ready";
      metrics: NfcCardMetric[];
      contacts: NfcContactRow[];
      events: NfcContactEventRow[];
      vcardProfile: NfcVCardProfile;
      fetchedAtLabel: string;
    }
  | {
      status: "missing-config" | "error";
      message: string;
    };

interface NfcAdminApiResponse {
  metrics: NfcCardMetric[];
  contacts: NfcContactRow[];
  events: NfcContactEventRow[];
}

interface NfcAdminApiConfig {
  contactsUrl: string;
  vcardUrl: string;
  apiKey: string | null;
}

function formatFetchedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function getNfcAdminApiConfig(): NfcAdminApiConfig {
  const contactsUrl =
    process.env.NFC_ADMIN_API_URL ?? "https://hi.dazbeez.com/admin/contacts";
  const adminBaseUrl = contactsUrl.replace(/\/contacts\/?$/, "");

  return {
    contactsUrl,
    vcardUrl: `${adminBaseUrl}/vcard`,
    apiKey: process.env.NFC_ADMIN_API_KEY ?? null,
  };
}

export function getNfcContactDeleteUrl(contactId: number): string {
  const { contactsUrl } = getNfcAdminApiConfig();
  return `${contactsUrl.replace(/\/$/, "")}/${contactId}`;
}

export async function getNfcAdminPanelData(): Promise<NfcAdminPanelData> {
  const { contactsUrl, vcardUrl, apiKey } = getNfcAdminApiConfig();

  if (!apiKey) {
    return {
      status: "missing-config",
      message:
        "Set NFC_ADMIN_API_KEY in the local server environment to show live NFC contacts here.",
    };
  }

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
    };
    const [contactsResponse, vcardResponse] = await Promise.all([
      fetch(contactsUrl, {
        method: "GET",
        headers,
        cache: "no-store",
      }),
      fetch(vcardUrl, {
        method: "GET",
        headers,
        cache: "no-store",
      }),
    ]);

    if (!contactsResponse.ok) {
      const body = await contactsResponse.text();
      return {
        status: "error",
        message: `NFC admin feed returned ${contactsResponse.status}. ${body.slice(0, 120)}`,
      };
    }

    if (!vcardResponse.ok) {
      const body = await vcardResponse.text();
      return {
        status: "error",
        message: `NFC vCard feed returned ${vcardResponse.status}. ${body.slice(0, 120)}`,
      };
    }

    const payload = (await contactsResponse.json()) as NfcAdminApiResponse;
    const vcardProfile = (await vcardResponse.json()) as NfcVCardProfile;
    return {
      status: "ready",
      metrics: payload.metrics,
      contacts: payload.contacts,
      events: payload.events,
      vcardProfile,
      fetchedAtLabel: formatFetchedAt(new Date()),
    };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? `NFC admin feed failed: ${error.message}`
          : "NFC admin feed failed for an unknown reason.",
    };
  }
}
