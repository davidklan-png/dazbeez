import Link from "next/link";

const services = [
  {
    slug: "ai",
    title: "AI Integration",
    description: "Build intelligent systems that learn from your data — from patient health assistants to Japanese-language document OCR.",
    fullDescription: "We design and deploy AI-powered applications tailored to your domain, integrating computer vision, large language models, and classification pipelines into production-grade workflows.",
    useCases: [
      "Patient health assistant with AI-guided symptom tracking",
      "Japanese receipt OCR using Google Cloud Vision API",
      "Multimodal document intelligence combining vision and language models",
      "Privacy-first AI design with zero full-document logging"
    ]
  },
  {
    slug: "automation",
    title: "Automation",
    description: "Replace manual workflows with reliable, self-hosted pipelines — from ETL processing to AI agent orchestration.",
    fullDescription: "We build automation systems that eliminate repetitive data tasks and reduce SaaS dependency, from financial ETL pipelines to AI agent frameworks.",
    useCases: [
      "ETL pipeline for Japanese credit card expense categorization with Shift-JIS/UTF-8 support",
      "SaaS cost tracker measuring open-source replacement savings (Bountymon)",
      "AI agent orchestration with the OpenClaw framework",
      "Automated attendee estimation from financial transaction amounts"
    ]
  },
  {
    slug: "data",
    title: "Data Management",
    description: "Structure, store, and audit your business data with full Japanese regulatory compliance and long-term retention.",
    fullDescription: "We build data management platforms that meet Japanese statutory requirements, including NTA invoice validation, 7-year retention policies, and MoneyForward-compatible exports.",
    useCases: [
      "NTA invoice registration number validation for Japanese tax compliance",
      "Seven-year data retention with automated compliant archiving",
      "MoneyForward-compatible monthly export for cooperative accounting",
      "Google Cloud Vision OCR for Japanese-language receipt capture on mobile"
    ]
  },
  {
    slug: "governance",
    title: "Governance",
    description: "Establish data policies, compliance frameworks, and privacy controls that protect your business under Japanese law.",
    fullDescription: "We design APPI-aligned governance frameworks covering data retention, cross-border transfer assessments, OAuth identity governance, and security hardening.",
    useCases: [
      "APPI-compliant privacy policy design for Japanese companies",
      "Data retention framework aligned to statutory requirements (7-year accounting, 90-day logs)",
      "Cross-border data transfer assessment under Article 28 of the APPI",
      "Security hardening: CORS allowlisting, rate limiting, and input validation"
    ]
  },
  {
    slug: "pm",
    title: "Project Management",
    description: "Deliver technical projects with precision — from greenfield builds to production-grade handoffs.",
    fullDescription: "We combine hands-on engineering with structured delivery discipline, shipping clean, testable, production-verified software ready to hand off.",
    useCases: [
      "Privacy-focused application design with zero PII logging enforced by policy",
      "Git hook enforcement of test coverage standards before every commit",
      "Rate-limited Cloudflare Worker API with strict CORS origin allowlisting",
      "Resume and job-description fit scoring with real-time character counting"
    ]
  }
];

export default function ServicesPage() {
  return (
    <div className="py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            Our Services
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Comprehensive solutions designed to accelerate your digital transformation
          </p>
        </div>

        {/* Services Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-16">
          {services.map((service) => (
            <Link
              key={service.slug}
              href={`/services/${service.slug}`}
              className="group p-8 bg-white rounded-2xl border border-gray-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300"
            >
              <h2 className="text-2xl font-semibold text-gray-900 mb-3">{service.title}</h2>
              <p className="text-gray-600 mb-4">{service.description}</p>
              <p className="text-sm text-amber-600 font-medium group-hover:text-amber-700">
                Learn more →
              </p>
            </Link>
          ))}
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            Not sure where to start?
          </h2>
          <p className="text-gray-300 mb-6 max-w-xl mx-auto">
            Our interactive inquiry flow can help you identify the right services for your needs.
          </p>
          <Link
            href="/inquiry"
            className="inline-block px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors"
          >
            Start Inquiry
          </Link>
        </div>
      </div>
    </div>
  );
}
