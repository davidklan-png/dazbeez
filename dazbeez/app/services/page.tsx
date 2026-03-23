import Link from "next/link";

const services = [
  {
    slug: "ai",
    title: "AI Integration",
    description: "Harness the power of artificial intelligence to transform your business operations.",
    fullDescription: "From machine learning models to generative AI, we help you identify opportunities and implement AI solutions that deliver real business value.",
    useCases: [
      "Predictive analytics for business forecasting",
      "Natural language processing for customer service",
      "Computer vision for quality control",
      "Generative AI for content creation"
    ]
  },
  {
    slug: "automation",
    title: "Automation",
    description: "Eliminate repetitive tasks and free your team to focus on what matters.",
    fullDescription: "We design and implement automation solutions that reduce errors, save time, and lower operational costs.",
    useCases: [
      "Workflow automation and process optimization",
      "RPA (Robotic Process Automation)",
      "API integrations and data sync",
      "Scheduled task automation"
    ]
  },
  {
    slug: "data",
    title: "Data Management",
    description: "Turn your data into a strategic asset with modern data architecture.",
    fullDescription: "We build data pipelines, warehouses, and analytics platforms that enable data-driven decision making.",
    useCases: [
      "Data warehouse design and implementation",
      "ETL pipeline development",
      "Business intelligence dashboards",
      "Data migration and cleanup"
    ]
  },
  {
    slug: "governance",
    title: "Governance",
    description: "Ensure your data is secure, compliant, and trustworthy.",
    fullDescription: "Establish governance frameworks that protect your organization while enabling innovation.",
    useCases: [
      "Data governance framework design",
      "Compliance consulting (GDPR, CCPA)",
      "Data quality management",
      "Security and access controls"
    ]
  },
  {
    slug: "pm",
    title: "Project Management",
    description: "Expert guidance for your digital transformation initiatives.",
    fullDescription: "Our experienced project managers ensure your initiatives are delivered on time, on budget, and to specification.",
    useCases: [
      "Digital transformation roadmapping",
      "Agile project management",
      "Stakeholder coordination",
      "Risk assessment and mitigation"
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
