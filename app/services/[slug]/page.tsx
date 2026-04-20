import Link from "next/link";
import { notFound } from "next/navigation";
import { HexIcon, hexAccent } from "@/components/hex-icon";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { isServiceSlug, services, serviceSlugs } from "@/lib/services";
import { caseStudiesByService } from "@/lib/case-studies";

export async function generateStaticParams() {
  return serviceSlugs.map((slug) => ({ slug }));
}

export default async function ServicePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!isServiceSlug(slug)) {
    notFound();
  }

  const service = services[slug];
  const accent = hexAccent(slug);
  const relatedStudies = caseStudiesByService(slug);

  return (
    <div className="py-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <Link
          href="/services"
          className="inline-flex items-center text-amber-600 hover:text-amber-700 mb-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Services
        </Link>

        {/* Header */}
        <Reveal>
          <div
            className="relative overflow-hidden mb-12 rounded-3xl border p-8 md:p-10"
            style={{ background: `linear-gradient(135deg, ${accent.fill} 0%, #ffffff 75%)`, borderColor: accent.fill }}
          >
            <HoneycombBackdrop opacity={0.12} color={accent.stroke} />
            <div className="relative flex flex-col gap-6 md:flex-row md:items-center">
              <HexIcon variant={slug} size="lg" label={`${service.title} icon`} />
              <div>
                <p
                  className="text-sm font-semibold uppercase tracking-[0.32em] mb-2"
                  style={{ color: accent.icon }}
                >
                  {service.title}
                </p>
                <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-3 leading-tight">
                  {service.description}
                </h1>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Full Description */}
        <Reveal>
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Overview</h2>
            <p className="text-lg text-gray-700 leading-relaxed">
              {service.fullDescription}
            </p>
          </section>
        </Reveal>

        {/* Use Cases */}
        <Reveal>
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">What We Deliver</h2>
            <ul className="grid md:grid-cols-2 gap-4">
              {service.useCases.map((useCase, index) => (
                <li key={index} className="flex items-start gap-3">
                  <span
                    className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold mt-0.5"
                    style={{ background: accent.fill, color: accent.icon, border: `1px solid ${accent.stroke}` }}
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                  <span className="text-gray-700">{useCase}</span>
                </li>
              ))}
            </ul>
          </section>
        </Reveal>

        {/* Related Services */}
        <Reveal>
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Pairs well with</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {service.related.map((relSlug) => {
                const rel = services[relSlug];
                return (
                  <Link
                    key={relSlug}
                    href={`/services/${relSlug}`}
                    className="group flex items-start gap-4 p-5 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    <HexIcon variant={relSlug} size="sm" label={`${rel.title} icon`} />
                    <div className="flex-1">
                      <h3 className="font-semibold text-gray-900 mb-1">{rel.title}</h3>
                      <p className="text-sm text-gray-600 line-clamp-2">{rel.description}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        </Reveal>

        {/* Case studies */}
        {relatedStudies.length > 0 && (
          <Reveal>
            <section className="mb-12">
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">In practice</h2>
              <div className="grid gap-4">
                {relatedStudies.map((study) => (
                  <Link
                    key={study.slug}
                    href={`/case-studies/${study.slug}`}
                    className="group flex items-start justify-between gap-4 p-5 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-400 mb-1">
                        {study.client}
                      </p>
                      <h3 className="font-semibold text-gray-900 group-hover:text-amber-700 transition-colors mb-1">
                        {study.title}
                      </h3>
                      <p className="text-sm text-gray-600">{study.tagline}</p>
                    </div>
                    <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                ))}
              </div>
            </section>
          </Reveal>
        )}

        {/* CTA */}
        <Reveal>
          <div
            className="rounded-2xl border p-8 text-center"
            style={{ background: accent.fill, borderColor: accent.stroke }}
          >
            <h2 className="text-2xl font-bold text-gray-900 mb-3">
              Ready to discuss {service.title}?
            </h2>
            <p className="text-gray-700 mb-6">
              Tell us the outcome you need. We&apos;ll reply within 24 hours with a
              concrete next step.
            </p>
            <Link
              href={`/contact?service=${slug}`}
              className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
            >
              Discuss {service.title}
            </Link>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
