import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | Dazbeez",
  description: "Privacy Policy for Dazbeez — how we collect, use, and protect your personal information under the Act on the Protection of Personal Information (APPI).",
  alternates: { canonical: "/privacy-policy" },
};

const EFFECTIVE_DATE = "April 15, 2026";

export default function PrivacyPolicyPage() {
  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="bg-gray-900 text-white py-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-amber-400 text-sm font-semibold uppercase tracking-wider mb-3">Legal</p>
          <h1 className="text-4xl font-bold mb-4">Privacy Policy</h1>
          <p className="text-gray-400">Effective Date: {EFFECTIVE_DATE}</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-12">

        {/* Intro */}
        <section>
          <p className="text-gray-700 leading-relaxed">
            Dazbeez G.K. (合同会社) (&ldquo;Dazbeez,&rdquo; &ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is a godo kaisha organized under the laws of Japan.
            This Privacy Policy explains how we collect, use, disclose, and safeguard personal information
            in accordance with Japan&rsquo;s <strong>Act on the Protection of Personal Information</strong> (個人情報保護法, &ldquo;APPI&rdquo;)
            and other applicable regulations.
          </p>
          <p className="text-gray-700 leading-relaxed mt-4">
            By accessing or using our website at <strong>dazbeez.com</strong> or engaging our services, you agree to the
            practices described in this Privacy Policy.
          </p>
        </section>

        {/* 1. Data Controller */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            1. Data Controller
          </h2>
          <div className="bg-gray-50 rounded-xl p-6 text-gray-700 space-y-2">
            <p><strong>Company Name:</strong> Dazbeez G.K. (合同会社)</p>
            <p><strong>Registered Country:</strong> Japan</p>
            <p><strong>Email:</strong>{" "}
              <a href="mailto:admin@dazbeez.com" className="text-amber-600 hover:text-amber-700 transition-colors">
                admin@dazbeez.com
              </a>
            </p>
            <p><strong>Website:</strong>{" "}
              <a href="https://dazbeez.com" className="text-amber-600 hover:text-amber-700 transition-colors">
                https://dazbeez.com
              </a>
            </p>
          </div>
        </section>

        {/* 2. Personal Information We Collect */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            2. Personal Information We Collect
          </h2>
          <p className="text-gray-700 mb-4">We may collect the following categories of personal information:</p>
          <ul className="space-y-3">
            {[
              ["Identity & Contact Information", "Name, email address, phone number, company name, job title."],
              ["Account Information", "Information provided when authenticating via Google OAuth (name, email address, profile picture)."],
              ["Inquiry & Communication Data", "Messages, project descriptions, and other content you submit through our contact or inquiry forms."],
              ["Usage Data", "IP address, browser type, pages visited, referring URLs, and timestamps — collected via server logs and analytics."],
              ["Cookies & Tracking", "Session identifiers and preference cookies required for site operation. See Section 8 for details."],
            ].map(([title, desc]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700">
                  <strong>{title}:</strong> {desc}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* 3. Purpose of Use */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            3. Purpose of Use (利用目的)
          </h2>
          <p className="text-gray-700 mb-4">
            Pursuant to Article 17 of the APPI, we use personal information only to the extent necessary for the following purposes:
          </p>
          <ol className="space-y-3 list-decimal list-inside text-gray-700">
            {[
              "Responding to inquiries and delivering requested services.",
              "Creating and managing client accounts and engagements.",
              "Sending service-related communications, updates, and invoices.",
              "Improving our website, products, and services through analytics.",
              "Complying with legal obligations under Japanese law.",
              "Preventing fraud and ensuring the security of our systems.",
            ].map((item) => (
              <li key={item} className="leading-relaxed">{item}</li>
            ))}
          </ol>
          <p className="text-gray-700 mt-4">
            If we intend to use personal information for a purpose other than those listed above, we will notify you
            and obtain your consent in advance.
          </p>
        </section>

        {/* 4. Legal Basis */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            4. Legal Basis for Processing
          </h2>
          <p className="text-gray-700">
            Under the APPI, we process personal information on the basis of:
          </p>
          <ul className="mt-4 space-y-3">
            {[
              ["Contract Performance", "Processing necessary to fulfil a contract with you or to take steps at your request before entering into a contract."],
              ["Legitimate Interests", "Operating and improving our website and services, provided your interests or rights do not override ours."],
              ["Legal Obligation", "Processing required to comply with Japanese law."],
              ["Consent", "Where we have obtained your explicit consent (e.g., for marketing communications)."],
            ].map(([title, desc]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700"><strong>{title}:</strong> {desc}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 5. Third-Party Disclosure */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            5. Disclosure to Third Parties (第三者提供)
          </h2>
          <p className="text-gray-700 mb-4">
            We do not sell your personal information. We may share it with third parties only in the following circumstances,
            in accordance with Article 27 of the APPI:
          </p>
          <ul className="space-y-3">
            {[
              ["Service Providers", "Trusted vendors who process data on our behalf (e.g., cloud hosting, analytics, email delivery), bound by confidentiality agreements."],
              ["Authentication Providers", "Google LLC, for sign-in functionality. Your use of Google OAuth is also governed by Google's Privacy Policy."],
              ["Legal Requirements", "When required by Japanese law, court order, or governmental authority."],
              ["Business Transfers", "In connection with a merger, acquisition, or sale of assets, subject to equivalent privacy protections."],
            ].map(([title, desc]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700"><strong>{title}:</strong> {desc}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 6. Cross-Border Transfers */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            6. Cross-Border Transfer of Personal Information (外国への提供)
          </h2>
          <p className="text-gray-700">
            Some of our service providers operate outside Japan (e.g., in the United States). When transferring personal
            information abroad, we take measures required under Article 28 of the APPI, including confirming that the
            recipient country has an adequate level of personal information protection or obtaining your consent where required.
            Upon request, we will provide information about the recipient country&rsquo;s data protection framework.
          </p>
        </section>

        {/* 7. Data Retention */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            7. Retention of Personal Information
          </h2>
          <p className="text-gray-700">
            We retain personal information only as long as necessary for the purposes described in Section 3, or as
            required by law. When personal information is no longer needed, we securely delete or anonymise it.
            Typical retention periods are:
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm text-gray-700 border border-gray-200 rounded-xl overflow-hidden">
              <thead className="bg-gray-50 text-gray-900 font-semibold">
                <tr>
                  <th className="px-4 py-3 text-left">Data Category</th>
                  <th className="px-4 py-3 text-left">Retention Period</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {[
                  ["Inquiry / contact form submissions", "3 years from last contact"],
                  ["Account / authentication data", "Duration of account + 1 year after deletion"],
                  ["Server logs & usage data", "90 days"],
                  ["Accounting & contract records", "7 years (statutory requirement)"],
                ].map(([cat, period]) => (
                  <tr key={cat} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">{cat}</td>
                    <td className="px-4 py-3">{period}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 8. Cookies */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            8. Cookies and Similar Technologies
          </h2>
          <p className="text-gray-700">
            Our website uses essential cookies necessary for authentication and site operation. We do not use advertising
            or cross-site tracking cookies. You may disable cookies in your browser settings, but doing so may affect
            the functionality of authenticated portions of the site.
          </p>
        </section>

        {/* 9. Your Rights */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            9. Your Rights (開示等の請求)
          </h2>
          <p className="text-gray-700 mb-4">
            Under the APPI, you have the right to request the following with respect to your personal information held by us:
          </p>
          <ul className="space-y-3">
            {[
              ["Disclosure (開示)", "Request notification of the purposes of use and a copy of the personal information we hold about you."],
              ["Correction (訂正)", "Request correction, addition, or deletion of inaccurate personal information."],
              ["Suspension of Use (利用停止)", "Request that we suspend use or erase your personal information where there are grounds under the APPI."],
              ["Suspension of Third-Party Provision (第三者提供の停止)", "Request that we stop providing your personal information to third parties."],
            ].map(([title, desc]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700"><strong>{title}:</strong> {desc}</span>
              </li>
            ))}
          </ul>
          <p className="text-gray-700 mt-4">
            To exercise these rights, please contact us at{" "}
            <a href="mailto:admin@dazbeez.com" className="text-amber-600 hover:text-amber-700 transition-colors">
              admin@dazbeez.com
            </a>
            . We will respond within the period required by the APPI (generally within 2 weeks of identity verification).
          </p>
        </section>

        {/* 10. Security */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            10. Security Measures
          </h2>
          <p className="text-gray-700">
            We implement appropriate technical and organisational security measures to protect personal information
            against unauthorised access, disclosure, alteration, or destruction, in accordance with Article 23 of the APPI.
            These measures include encrypted data transmission (TLS), access controls, and regular security reviews.
          </p>
        </section>

        {/* 11. Complaints */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            11. Complaints and Supervisory Authority
          </h2>
          <p className="text-gray-700">
            If you have a complaint regarding our handling of your personal information, please contact us first at{" "}
            <a href="mailto:admin@dazbeez.com" className="text-amber-600 hover:text-amber-700 transition-colors">
              admin@dazbeez.com
            </a>
            . If you are not satisfied with our response, you may lodge a complaint with the{" "}
            <strong>Personal Information Protection Commission (個人情報保護委員会, PPC)</strong> at{" "}
            <a
              href="https://www.ppc.go.jp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-600 hover:text-amber-700 transition-colors"
            >
              www.ppc.go.jp
            </a>
            .
          </p>
        </section>

        {/* 12. Updates */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            12. Changes to This Policy
          </h2>
          <p className="text-gray-700">
            We may update this Privacy Policy from time to time. Material changes will be notified via a prominent notice
            on our website at least 30 days before they take effect. Continued use of our services after the effective
            date constitutes acceptance of the updated policy.
          </p>
        </section>

        {/* Contact */}
        <section className="bg-amber-50 border border-amber-200 rounded-xl p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Contact Us</h2>
          <p className="text-gray-700 mb-4">
            For privacy-related inquiries or to exercise your rights under the APPI, please contact our Privacy Officer:
          </p>
          <a
            href="mailto:admin@dazbeez.com"
            className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors"
          >
            admin@dazbeez.com
          </a>
        </section>

        {/* Related */}
        <div className="flex flex-wrap gap-4 pt-4 border-t border-gray-200 text-sm text-gray-500">
          <Link href="/terms-of-service" className="text-amber-600 hover:text-amber-700 transition-colors">
            Terms of Service →
          </Link>
          <Link href="/" className="hover:text-gray-700 transition-colors">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
