import type { Metadata } from "next";
import Link from "next/link";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";

export const metadata: Metadata = {
  title: "About — Dazbeez",
  description:
    "Meet David Klan, the consultant behind Dazbeez: production AI, automation, and data systems for Japanese regulatory environments and Hawaii-based businesses.",
  alternates: {
    canonical: "/about",
  },
};

const openProjects = [
  "AI integration for Japanese document workflows",
  "Data governance audits for APPI and cross-border transfer risk",
  "Automation projects that reduce SaaS costs with self-hosted workflows",
];

export default function AboutPage() {
  return (
    <div className="bg-[linear-gradient(180deg,#111827_0%,#18202d_24%,#f9fafb_24%,#ffffff_100%)]">
      <section className="relative overflow-hidden text-white">
        <HoneycombBackdrop opacity={0.08} color="#FBBF24" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.24),transparent_34%)]" />

        <div className="relative max-w-5xl mx-auto px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <Reveal>
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-300">
              About
            </p>
            <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">David Klan</h1>
            <p className="mt-4 max-w-2xl text-xl text-gray-300">
              AI, Automation &amp; Data Consultant. Based in Japan.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)] lg:items-start">
              <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-[0_24px_80px_-48px_rgba(17,24,39,0.4)]">
                <h2 className="text-2xl font-semibold text-gray-900">What I do</h2>
                <div className="mt-6 space-y-5 text-base leading-8 text-gray-700">
                  <p>
                    I started as a software engineer and moved into consulting because most teams do not need more
                    theory. They need systems that survive real constraints. Today I build AI and data systems for
                    Japanese regulatory environments and Hawaii-based businesses, with a practical connection back to
                    the University of Hawaii Shidler College of Business.
                  </p>
                  <p>
                    What I actually build is production infrastructure: AI systems with audit trails, automation
                    pipelines that replace recurring SaaS subscriptions, and data governance that stands up to APPI
                    scrutiny. If the workflow needs to be bilingual, explainable, recoverable, and maintainable by a
                    small team, that is usually where I fit.
                  </p>
                  <p>
                    I work remote-first and prefer fixed-scope engagements with clear deliverables. I do not push
                    retainers unless the work justifies them. Most of the time the better path is to scope the job,
                    ship it cleanly, document it properly, and leave you with something your team can run. I reply
                    within 24 hours.
                  </p>
                </div>
              </div>

              <aside className="rounded-3xl border border-amber-100 bg-amber-50 p-8">
                <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-700">
                  Currently accepting
                </p>
                <ul className="mt-6 space-y-4">
                  {openProjects.map((project) => (
                    <li key={project} className="flex gap-3 text-sm leading-7 text-gray-700">
                      <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                      <span>{project}</span>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="pb-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="rounded-3xl bg-gray-900 p-8 text-white shadow-[0_24px_80px_-48px_rgba(17,24,39,0.65)]">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-300">
                Work together
              </p>
              <h2 className="mt-3 text-3xl font-bold">If the constraints are real, start with the details.</h2>
              <p className="mt-4 max-w-2xl text-gray-300">
                Send the situation, the timeline, and what has to keep working when the project is done.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="https://www.linkedin.com/in/david-klan"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 font-semibold text-white transition-colors hover:border-amber-300 hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                >
                  Connect on LinkedIn
                </a>
                <Link
                  href="/contact"
                  className="inline-flex items-center justify-center rounded-full bg-amber-500 px-6 py-3 font-semibold text-white transition-colors hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                >
                  Contact Dazbeez
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
