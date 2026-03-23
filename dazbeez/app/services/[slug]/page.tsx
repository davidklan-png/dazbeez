import Link from "next/link";
import { notFound } from "next/navigation";

const servicesData: Record<string, {
  title: string;
  description: string;
  fullDescription: string;
  useCases: string[];
  icon: string;
}> = {
  ai: {
    title: "AI Integration",
    description: "Harness the power of artificial intelligence to transform your business operations.",
    fullDescription: "From machine learning models to generative AI, we help you identify opportunities and implement AI solutions that deliver real business value.",
    useCases: [
      "Predictive analytics for business forecasting",
      "Natural language processing for customer service",
      "Computer vision for quality control",
      "Generative AI for content creation",
      "Recommendation engines",
      "Sentiment analysis"
    ],
    icon: "🤖"
  },
  automation: {
    title: "Automation",
    description: "Eliminate repetitive tasks and free your team to focus on what matters.",
    fullDescription: "We design and implement automation solutions that reduce errors, save time, and lower operational costs across your organization.",
    useCases: [
      "Workflow automation and process optimization",
      "RPA (Robotic Process Automation)",
      "API integrations and data sync",
      "Scheduled task automation",
      "Email automation and routing",
      "Document processing automation"
    ],
    icon: "⚙️"
  },
  data: {
    title: "Data Management",
    description: "Turn your data into a strategic asset with modern data architecture.",
    fullDescription: "We build data pipelines, warehouses, and analytics platforms that enable data-driven decision making at every level of your organization.",
    useCases: [
      "Data warehouse design and implementation",
      "ETL pipeline development",
      "Business intelligence dashboards",
      "Data migration and cleanup",
      "Real-time data streaming",
      "Data lake architecture"
    ],
    icon: "📊"
  },
  governance: {
    title: "Governance",
    description: "Ensure your data is secure, compliant, and trustworthy.",
    fullDescription: "Establish governance frameworks that protect your organization while enabling innovation and maintaining trust with your customers.",
    useCases: [
      "Data governance framework design",
      "Compliance consulting (GDPR, CCPA)",
      "Data quality management",
      "Security and access controls",
      "Audit trail implementation",
      "Privacy by design"
    ],
    icon: "🛡️"
  },
  pm: {
    title: "Project Management",
    description: "Expert guidance for your digital transformation initiatives.",
    fullDescription: "Our experienced project managers ensure your initiatives are delivered on time, on budget, and to specification while maintaining stakeholder alignment.",
    useCases: [
      "Digital transformation roadmapping",
      "Agile project management",
      "Stakeholder coordination",
      "Risk assessment and mitigation",
      "Resource planning",
      "Change management"
    ],
    icon: "📋"
  }
};

export async function generateStaticParams() {
  return Object.keys(servicesData).map((slug) => ({ slug }));
}

export default function ServicePage({ params }: { params: { slug: string } }) {
  const service = servicesData[params.slug];

  if (!service) {
    notFound();
  }

  return (
    <div className="py-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <Link href="/services" className="inline-flex items-center text-amber-600 hover:text-amber-700 mb-8">
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Services
        </Link>

        {/* Header */}
        <div className="mb-12">
          <div className="text-6xl mb-4">{service.icon}</div>
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            {service.title}
          </h1>
          <p className="text-xl text-gray-600">
            {service.description}
          </p>
        </div>

        {/* Full Description */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold text-gray-900 mb-4">Overview</h2>
          <p className="text-lg text-gray-700 leading-relaxed">
            {service.fullDescription}
          </p>
        </section>

        {/* Use Cases */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold text-gray-900 mb-4">What We Deliver</h2>
          <ul className="grid md:grid-cols-2 gap-4">
            {service.useCases.map((useCase, index) => (
              <li key={index} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center text-sm font-semibold mt-0.5">
                  ✓
                </span>
                <span className="text-gray-700">{useCase}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* CTA */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-3">
            Ready to explore {service.title}?
          </h2>
          <p className="text-gray-600 mb-6">
            Start an inquiry to discuss how we can help with your specific needs.
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
