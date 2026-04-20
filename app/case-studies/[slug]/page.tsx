import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HexIcon } from "@/components/hex-icon";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { caseStudies, caseStudySlugs, isCaseStudySlug } from "@/lib/case-studies";
import { services } from "@/lib/services";

export async function generateStaticParams() {
  return caseStudySlugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isCaseStudySlug(slug)) return {};
  const study = caseStudies[slug];
  return {
    title: `${study.title} | Dazbeez`,
    description: study.tagline,
    alternates: { canonical: `/case-studies/${slug}` },
  };
}

export default async function CaseStudyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!isCaseStudySlug(slug)) {
    notFound();
  }

  const study = caseStudies[slug];

  return (
    <div className="py-16">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <Link
          href="/case-studies"
          className="inline-flex items-center text-amber-600 hover:text-amber-700 mb-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All case studies
        </Link>

        {/* Hero */}
        <Reveal>
          <div className="relative overflow-hidden mb-12 rounded-3xl bg-gradient-to-br from-gray-900 to-gray-800 p-8 md:p-10 text-white">
            <HoneycombBackdrop opacity={0.1} color="#FBBF24" />
            <div className="relative">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300 mb-3">
                {study.client}
              </p>
              <h1 className="text-3xl md:text-4xl font-bold mb-3 leading-tight">
                {study.title}
              </h1>
              <p className="text-gray-300 text-lg mb-6">{study.tagline}</p>
              <div className="flex flex-wrap gap-2">
                {study.relatedServices.map((svc) => (
                  <Link
                    key={svc}
                    href={`/services/${svc}`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                  >
                    <HexIcon variant={svc} size="sm" label="" />
                    {services[svc].title}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        {/* Problem */}
        <Reveal>
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </span>
              <h2 className="text-xl font-semibold text-gray-900">The Problem</h2>
            </div>
            <p className="text-gray-700 leading-relaxed pl-11">{study.problem}</p>
          </section>
        </Reveal>

        {/* Solution */}
        <Reveal>
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </span>
              <h2 className="text-xl font-semibold text-gray-900">What We Built</h2>
            </div>
            <p className="text-gray-700 leading-relaxed pl-11">{study.solution}</p>
          </section>
        </Reveal>

        {/* Outcome */}
        <Reveal>
          <section className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              <h2 className="text-xl font-semibold text-gray-900">Outcome</h2>
            </div>
            <p className="text-gray-700 leading-relaxed pl-11">{study.outcome}</p>
          </section>
        </Reveal>

        {/* Tech stack */}
        <Reveal>
          <section className="mb-12">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Tech Stack</h2>
            <div className="flex flex-wrap gap-2">
              {study.techStack.map((tech) => (
                <span
                  key={tech}
                  className="px-3 py-1.5 rounded-full bg-gray-100 text-gray-700 text-sm font-medium"
                >
                  {tech}
                </span>
              ))}
            </div>
          </section>
        </Reveal>

        {/* Related services */}
        <Reveal>
          <section className="mb-12">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Services used</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {study.relatedServices.map((svc) => {
                const service = services[svc];
                return (
                  <Link
                    key={svc}
                    href={`/services/${svc}`}
                    className="group flex items-start gap-4 p-5 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    <HexIcon variant={svc} size="sm" label={`${service.title} icon`} />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 mb-1">{service.title}</h3>
                      <p className="text-sm text-gray-600 line-clamp-2">{service.description}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        </Reveal>

        {/* CTA */}
        <Reveal>
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-8 text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-3">
              Facing a similar challenge?
            </h2>
            <p className="text-gray-700 mb-6">
              Tell us the outcome you need. We&apos;ll reply within 24 hours with a
              concrete next step.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href={`/contact?service=${study.relatedServices[0]}`}
                className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                Book a consultation
              </Link>
              <Link
                href="/case-studies"
                className="inline-block px-8 py-3 border border-gray-300 hover:border-gray-500 text-gray-900 font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                More case studies
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
