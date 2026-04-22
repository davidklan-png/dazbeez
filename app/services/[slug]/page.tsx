import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HexIcon, hexAccent } from "@/components/hex-icon";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { serviceIllustrations } from "@/lib/service-assets";
import { isServiceSlug, services, serviceSlugs } from "@/lib/services";
import { caseStudiesByService } from "@/lib/case-studies";

type ServicePageProps = {
  params: Promise<{ slug: string }>;
};

function truncateDescription(description: string, maxLength = 155) {
  if (description.length <= maxLength) {
    return description;
  }

  return `${description.slice(0, maxLength - 1).trimEnd()}…`;
}

export async function generateStaticParams() {
  return serviceSlugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: ServicePageProps): Promise<Metadata> {
  const { slug } = await params;

  if (!isServiceSlug(slug)) {
    notFound();
  }

  const service = services[slug];

  return {
    title: `${service.title} — Dazbeez`,
    description: truncateDescription(service.fullDescription),
    alternates: {
      canonical: `/services/${slug}`,
    },
  };
}

export default async function ServicePage({ params }: ServicePageProps) {
  const { slug } = await params;

  if (!isServiceSlug(slug)) {
    notFound();
  }

  const service = services[slug];
  const accent = hexAccent(slug);
  const relatedStudies = caseStudiesByService(slug);
  const illustrationSrc = serviceIllustrations[slug];

  return (
    <div className="py-16">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
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
            <div className="relative">
              <div className="min-w-0 max-w-3xl">
                <div className="mb-5 flex flex-wrap items-center gap-4">
                  <HexIcon variant={slug} size="lg" label={`${service.title} icon`} />
                  <p
                    className="text-sm font-semibold uppercase tracking-[0.32em]"
                    style={{ color: accent.icon }}
                  >
                    {service.title}
                  </p>
                </div>
                <h1 className="max-w-[16ch] text-4xl font-bold leading-[1.05] tracking-tight text-gray-900 md:text-5xl xl:text-[3.2rem]">
                  {service.description}
                </h1>
              </div>

              {illustrationSrc ? (
                <div className="relative mt-8 flex justify-center md:mt-10 lg:justify-end">
                  <Image
                    src={illustrationSrc}
                    alt={`${service.title} illustration`}
                    width={600}
                    height={400}
                    priority
                    sizes="(min-width: 1280px) 520px, (min-width: 1024px) 40vw, (min-width: 640px) 28rem, 100vw"
                    className="h-auto w-full max-w-sm drop-shadow-[0_28px_48px_rgba(17,24,39,0.14)] sm:max-w-md lg:max-w-lg"
                  />
                </div>
              ) : null}
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
              Describe your situation and constraints. We&apos;ll come back within 24
              hours with a concrete recommendation — not a generic brochure.
            </p>
            <Link
              href={`/contact?service=${slug}`}
              className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
            >
              Discuss {service.title}
            </Link>
          </div>
        </Reveal>

        <div className="mt-4 text-right">
          <a
            href="#main-content"
            className="text-sm text-gray-400 transition-colors hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
          >
            ↑ Back to top
          </a>
        </div>
      </div>
    </div>
  );
}
