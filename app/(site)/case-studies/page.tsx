import Link from "next/link";
import type { Metadata } from "next";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { caseStudyList } from "@/lib/case-studies";
import { services } from "@/lib/services";

export const metadata: Metadata = {
  title: "Selected Work | Dazbeez",
  description:
    "Case studies in AI integration, automation, data management, and governance — built to Japanese regulatory standards.",
  alternates: { canonical: "/case-studies" },
};

export default function CaseStudiesPage() {
  return (
    <div className="relative py-16 overflow-hidden">
      <HoneycombBackdrop opacity={0.05} color="#B45309" />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Reveal>
          <div className="text-center mb-16">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
              Selected Work
            </p>
            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
              Problems solved, systems shipped.
            </h1>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Each engagement below started with a concrete operational problem
              and ended with a production system. No slide decks — just code,
              data, and measurable outcomes.
            </p>
          </div>
        </Reveal>

        <div className="grid md:grid-cols-2 gap-8">
          {caseStudyList.map((study, idx) => (
            <Reveal key={study.slug} delay={idx * 0.07}>
              <Link
                href={`/case-studies/${study.slug}`}
                className="group flex flex-col h-full bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <div className="p-7 flex-1">
                  <div className="flex flex-wrap gap-2 mb-4">
                    {study.relatedServices.map((svc) => (
                      <span
                        key={svc}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200"
                      >
                        {services[svc].title}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-400 mb-2">
                    {study.client}
                  </p>
                  <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-700 transition-colors">
                    {study.title}
                  </h2>
                  <p className="text-gray-600 text-sm leading-relaxed">{study.tagline}</p>
                </div>

                <div className="px-7 pb-6">
                  <div className="flex flex-wrap gap-1.5 mb-5">
                    {study.techStack.slice(0, 4).map((tech) => (
                      <span
                        key={tech}
                        className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium"
                      >
                        {tech}
                      </span>
                    ))}
                    {study.techStack.length > 4 && (
                      <span className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                        +{study.techStack.length - 4} more
                      </span>
                    )}
                  </div>
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

        <Reveal>
          <div className="relative overflow-hidden mt-16 bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-8 md:p-12 text-center text-white">
            <HoneycombBackdrop opacity={0.08} color="#FBBF24" />
            <div className="relative">
              <h2 className="text-2xl md:text-3xl font-bold mb-4">
                Working on a similar problem?
              </h2>
              <p className="text-gray-300 mb-6 max-w-xl mx-auto">
                Describe the outcome you need. We&apos;ll tell you which services apply
                and what a realistic first step looks like.
              </p>
              <Link
                href="/contact"
                className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                Book a consultation
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
