import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { HexIcon } from "@/components/hex-icon";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { serviceList, services } from "@/lib/services";
import { caseStudyList } from "@/lib/case-studies";

const processSteps = [
  {
    title: "Discovery call",
    description: "30-minute scoped conversation to identify the problem worth solving.",
  },
  {
    title: "Proposal",
    description: "Fixed-scope statement of work with clear deliverables and timeline.",
  },
  {
    title: "Build & iterate",
    description: "Incremental delivery with test coverage and weekly check-ins.",
  },
  {
    title: "Hand-off",
    description: "Full documentation, runbooks, and a 30-day support window.",
  },
];

const platformBadges = [
  "Next.js",
  "Cloudflare",
  "Google Cloud",
  "Tailwind CSS",
  "TypeScript",
];

export const metadata: Metadata = {
  title: "Dazbeez — AI, Automation & Data Consulting",
  description:
    "We design AI, automation, and data systems for businesses that need the work to still be correct in five years.",
  alternates: {
    canonical: "/",
  },
};

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
        <HoneycombBackdrop opacity={0.08} color="#FBBF24" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-amber-500/20 via-transparent to-transparent" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 md:py-32">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(240px,360px)]">
            <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-300 mb-5">
              AI · Automation · Data
            </p>
            <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-[1.05] tracking-tight">
              Engineering that
              <span className="relative inline-block px-2">
                <span className="relative z-10 text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-amber-500">
                  compounds
                </span>
                <span className="absolute inset-x-1 bottom-1 h-3 bg-amber-500/30 -z-0 rounded" />
              </span>
              — not accumulates.
            </h1>
            <p className="text-xl text-gray-300 mb-10 max-w-2xl leading-relaxed">
              We design AI, automation, and data systems for businesses that need
              the work to still be correct in five years — auditable, testable, and
              built to Japanese regulatory standards.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 px-7 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                Book a consultation
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center gap-2 px-7 py-3 border border-white/30 hover:border-amber-300/80 hover:text-amber-200 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                Browse services
              </Link>
            </div>
            <p className="mt-6 text-center text-sm text-gray-400">
              Serving clients in Japan and Hawaii · Built to Japanese regulatory standards
            </p>
            </div>

            <div className="mx-auto w-full max-w-[240px] sm:max-w-[280px] lg:max-w-[340px]">
              <Image
                src="/illustrations/hero-bee.svg"
                alt=""
                aria-hidden="true"
                width={200}
                height={200}
                priority
                sizes="(min-width: 1024px) 340px, (min-width: 640px) 280px, 240px"
                className="h-auto w-full"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section className="relative py-20 bg-gray-50 overflow-hidden">
        <HoneycombBackdrop opacity={0.05} color="#92400E" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="text-center mb-16">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
                How we help
              </p>
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
                Five disciplines, one honeycomb.
              </h2>
              <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                Engagements combine these disciplines — most clients start with one
                and stitch the others in as the system grows.
              </p>
            </div>
          </Reveal>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {serviceList.map((service, idx) => (
              <Reveal key={service.slug} delay={idx * 0.06}>
                <Link
                  href={`/services/${service.slug}`}
                  className="group block h-full p-7 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-lg transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  <div className="mb-5 transition-transform duration-300 group-hover:-translate-y-0.5">
                    <HexIcon variant={service.slug} size="md" label={`${service.title} icon`} />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">{service.title}</h3>
                  <p className="text-gray-600 text-sm leading-relaxed">{service.description}</p>
                  <span className="inline-flex items-center gap-1 mt-5 text-amber-600 font-medium group-hover:gap-2 transition-all">
                    Learn more
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Selected Work Section */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-12">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
                  Selected Work
                </p>
                <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
                  Problems solved, systems shipped.
                </h2>
              </div>
              <Link
                href="/case-studies"
                className="text-amber-600 hover:text-amber-700 font-medium inline-flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
              >
                See all work
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </Reveal>

          <div className="grid md:grid-cols-3 gap-6">
            {caseStudyList.slice(0, 3).map((study, idx) => (
              <Reveal key={study.slug} delay={idx * 0.07}>
                <Link
                  href={`/case-studies/${study.slug}`}
                  className="group flex flex-col h-full bg-gray-50 rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-lg transition-all duration-300 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  <div className="p-6 flex-1">
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {study.relatedServices.map((svc) => (
                        <span
                          key={svc}
                          className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700"
                        >
                          {services[svc].title}
                        </span>
                      ))}
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2 group-hover:text-amber-700 transition-colors">
                      {study.title}
                    </h3>
                    <p className="text-gray-600 text-sm leading-relaxed">{study.tagline}</p>
                  </div>
                  <div className="px-6 pb-5">
                    <span className="inline-flex items-center gap-1 text-amber-600 font-medium text-sm group-hover:gap-2 transition-all">
                      Read case study
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </span>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="text-center mb-12">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
                How it works
              </p>
              <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
                Fixed scope, direct execution, clean hand-off.
              </h2>
              <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                The process stays simple on purpose: define the right problem,
                agree the work, ship in increments, and leave the team with something maintainable.
              </p>
            </div>

            <div className="overflow-hidden rounded-3xl border border-amber-100 bg-white shadow-[0_24px_80px_-48px_rgba(17,24,39,0.45)]">
              <div className="grid divide-y divide-amber-100 md:grid-cols-4 md:divide-x md:divide-y-0">
                {processSteps.map((step, index) => (
                  <article key={step.title} className="p-6 md:p-7">
                    <div className="flex items-center gap-4">
                      <span className="grid h-11 w-11 place-items-center rounded-full bg-amber-500 text-base font-semibold text-white">
                        {index + 1}
                      </span>
                      <h3 className="text-lg font-semibold text-gray-900">{step.title}</h3>
                    </div>
                    <p className="mt-4 text-sm leading-7 text-gray-600">{step.description}</p>
                  </article>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <Reveal>
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
              Ready to talk specifics?
            </h2>
            <p className="text-xl text-gray-600 mb-8">
              Tell us the outcome you need and the constraints you&apos;re working under.
              We&apos;ll reply within 24 hours with a concrete next step.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 px-8 py-4 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                Book a consultation
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center gap-2 px-8 py-4 border border-gray-300 hover:border-gray-900 text-gray-900 font-semibold rounded-full transition-colors text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                Browse services
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Trust Bar */}
      <section className="bg-gray-900 py-5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-center gap-2 text-center sm:flex-row sm:gap-3">
            <span className="text-xs font-medium uppercase tracking-[0.28em] text-gray-500">
              Built on
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300">
              {platformBadges.join(" · ")}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
