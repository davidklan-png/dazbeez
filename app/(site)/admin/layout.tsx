import Link from "next/link";
import { assertAdminPageAccess } from "@/lib/admin-page-auth-request";

const adminLinks = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/batches", label: "Batch Uploads" },
  { href: "/admin/review", label: "Review Queue" },
  { href: "/admin/contacts", label: "Contacts" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/drafts", label: "Draft Emails" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await assertAdminPageAccess();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:px-8">
        <aside className="w-full shrink-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm lg:w-64 lg:self-start">
          <div className="border-b border-gray-100 pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
              Dazbeez Admin
            </p>
            <h1 className="mt-2 text-xl font-semibold text-gray-900">CRM Console</h1>
            <p className="mt-2 text-sm text-gray-500">
              Business card ingestion, CRM review, enrichment, and follow-up drafting.
            </p>
          </div>
          <nav className="mt-4 space-y-1">
            {adminLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block rounded-xl px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-amber-50 hover:text-amber-700"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
