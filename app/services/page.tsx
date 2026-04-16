import Link from "next/link";
import { HexIcon } from "@/components/hex-icon";
import { HoneycombBackdrop } from "@/components/honeycomb-backdrop";
import { Reveal } from "@/components/reveal";
import { serviceList } from "@/lib/services";

export default function ServicesPage() {
  return (
    <div className="relative py-16 overflow-hidden">
      <HoneycombBackdrop opacity={0.05} color="#B45309" />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <Reveal>
          <div className="text-center mb-16">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600 mb-3">
              Services
            </p>
            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
              Five disciplines, built to combine.
            </h1>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Each service stands alone, but the value compounds when you stitch
              them together. Start anywhere; grow into the rest when it&apos;s time.
            </p>
          </div>
        </Reveal>

        {/* Services Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {serviceList.map((service, idx) => (
            <Reveal key={service.slug} delay={idx * 0.06}>
              <Link
                href={`/services/${service.slug}`}
                className="group flex h-full flex-col p-8 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <div className="mb-5 transition-transform duration-300 group-hover:-translate-y-0.5">
                  <HexIcon variant={service.slug} size="md" label={`${service.title} icon`} />
                </div>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">{service.title}</h2>
                <p className="text-gray-600 mb-4 flex-1">{service.description}</p>
                <p className="text-sm text-amber-600 font-medium group-hover:text-amber-700">
                  Learn more →
                </p>
              </Link>
            </Reveal>
          ))}
        </div>

        {/* CTA */}
        <Reveal>
          <div className="relative overflow-hidden bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-8 md:p-12 text-center text-white">
            <HoneycombBackdrop opacity={0.08} color="#FBBF24" />
            <div className="relative">
              <h2 className="text-2xl md:text-3xl font-bold mb-4">
                Not sure which to start with?
              </h2>
              <p className="text-gray-300 mb-6 max-w-xl mx-auto">
                Describe the outcome you need. We&apos;ll tell you which services apply
                and which don&apos;t.
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
