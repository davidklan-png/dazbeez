import Link from "next/link";

const services = [
  {
    title: "AI Integration",
    description: "Leverage AI to automate decisions, enhance customer experiences, and unlock new insights.",
    icon: "🤖",
    slug: "ai"
  },
  {
    title: "Automation",
    description: "Streamline workflows and eliminate repetitive tasks with intelligent automation solutions.",
    icon: "⚙️",
    slug: "automation"
  },
  {
    title: "Data Management",
    description: "Transform raw data into actionable intelligence with robust data architecture.",
    icon: "📊",
    slug: "data"
  },
  {
    title: "Governance",
    description: "Ensure compliance, security, and quality with comprehensive data governance frameworks.",
    icon: "🛡️",
    slug: "governance"
  },
  {
    title: "Project Management",
    description: "Expert guidance for your digital transformation initiatives from concept to delivery.",
    icon: "📋",
    slug: "pm"
  }
];

function ServiceCard({ title, description, icon, slug }: { title: string; description: string; icon: string; slug: string }) {
  return (
    <Link
      href={`/services/${slug}`}
      className="group p-6 bg-white rounded-xl border border-gray-200 hover:border-amber-400 hover:shadow-lg transition-all duration-300"
    >
      <div className="text-4xl mb-4 transform group-hover:scale-110 transition-transform">{icon}</div>
      <h3 className="text-xl font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-600">{description}</p>
      <span className="inline-flex items-center gap-1 mt-4 text-amber-600 font-medium group-hover:gap-2 transition-all">
        Learn more
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </Link>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-amber-500/20 via-transparent to-transparent"></div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 md:py-32">
          <div className="max-w-3xl">
            <h1 className="text-4xl md:text-6xl font-bold mb-6 leading-tight">
              Transform Your Business with
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-amber-600"> AI & Automation</span>
            </h1>
            <p className="text-xl text-gray-300 mb-8">
              We help businesses leverage cutting-edge technology to streamline operations, make smarter decisions, and accelerate growth.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link
                href="/inquiry"
                className="px-8 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors"
              >
                Start Your Journey
              </Link>
              <Link
                href="/services"
                className="px-8 py-3 border border-white/30 hover:border-white/60 text-white font-semibold rounded-full transition-colors"
              >
                Explore Services
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              How We Can Help
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Comprehensive solutions for the modern digital enterprise
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {services.map((service) => (
              <ServiceCard key={service.slug} {...service} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
            Ready to Get Started?
          </h2>
          <p className="text-xl text-gray-600 mb-8">
            Answer a few questions and we'll guide you to the right solution for your needs.
          </p>
          <Link
            href="/inquiry"
            className="inline-flex items-center gap-2 px-8 py-4 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors text-lg"
          >
            Launch Interactive Inquiry
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
        </div>
      </section>
    </div>
  );
}
