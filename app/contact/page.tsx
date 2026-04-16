import type { Metadata } from "next";
import { ContactForm } from "@/components/contact-form";
import { isServiceSlug, services } from "@/lib/services";

export const metadata: Metadata = {
  title: "Contact — Dazbeez",
  description:
    "Tell us about the outcome you need and the constraints you're working under. We reply within 24 hours.",
  alternates: { canonical: "/contact" },
};

type SearchParams = Promise<{ service?: string | string[] }>;

export default async function ContactPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const raw = typeof sp.service === "string" ? sp.service : Array.isArray(sp.service) ? sp.service[0] : undefined;
  const preselected = isServiceSlug(raw) ? raw : "";
  const preselectedTitle = preselected ? services[preselected].title : "";

  return (
    <div className="py-16">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
            Contact
          </p>
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 leading-tight">
            {preselectedTitle
              ? `Let\u2019s talk about ${preselectedTitle}.`
              : "Let\u2019s talk about what you\u2019re building."}
          </h1>
          <p className="text-lg text-gray-600">
            Tell us the outcome you need and the constraints you&apos;re working under.
            We reply within 24 hours.
          </p>
        </div>

        <ContactForm
          defaultService={preselected}
          eyebrow={preselectedTitle ? preselectedTitle : "Contact"}
          headline={
            preselectedTitle
              ? `Tell us more about your ${preselectedTitle.toLowerCase()} project.`
              : "Tell us what you're trying to build."
          }
          source={preselected ? `service:${preselected}` : undefined}
        />

        <div className="mt-12 grid md:grid-cols-3 gap-6 text-center">
          <div className="p-6">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="font-semibold text-gray-900 mb-1">Email</h2>
            <p className="text-gray-600">hello@dazbeez.com</p>
          </div>

          <div className="p-6">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h2 className="font-semibold text-gray-900 mb-1">Location</h2>
            <p className="text-gray-600">Remote-first</p>
          </div>

          <div className="p-6">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="font-semibold text-gray-900 mb-1">Response time</h2>
            <p className="text-gray-600">Within 24 hours</p>
          </div>
        </div>
      </div>
    </div>
  );
}
