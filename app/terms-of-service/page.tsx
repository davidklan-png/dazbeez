import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service | Dazbeez",
  description: "Terms of Service governing your use of Dazbeez's website and AI, Automation & Data consulting services.",
  alternates: { canonical: "/terms-of-service" },
};

const EFFECTIVE_DATE = "April 15, 2026";

export default function TermsOfServicePage() {
  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="bg-gray-900 text-white py-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-amber-400 text-sm font-semibold uppercase tracking-wider mb-3">Legal</p>
          <h1 className="text-4xl font-bold mb-4">Terms of Service</h1>
          <p className="text-gray-400">Effective Date: {EFFECTIVE_DATE}</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-12">

        {/* Intro */}
        <section>
          <p className="text-gray-700 leading-relaxed">
            These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement between you
            (&ldquo;User,&rdquo; &ldquo;you,&rdquo; or &ldquo;your&rdquo;) and <strong>Dazbeez G.K. (合同会社)</strong>
            (&ldquo;Dazbeez,&rdquo; &ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;), a godo kaisha organized
            under the laws of Japan, governing your access to and use of the website
            at <strong>dazbeez.com</strong> and any related services (collectively, the &ldquo;Service&rdquo;).
          </p>
          <p className="text-gray-700 leading-relaxed mt-4">
            By accessing or using the Service, you confirm that you have read, understood, and agree to be bound
            by these Terms and our <Link href="/privacy-policy" className="text-amber-600 hover:text-amber-700 transition-colors">Privacy Policy</Link>.
            If you do not agree, please discontinue use of the Service immediately.
          </p>
        </section>

        {/* 1. Services */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            1. Description of Services
          </h2>
          <p className="text-gray-700">
            Dazbeez provides AI integration, business automation, data management, data governance, and project
            management consulting services to businesses and organisations. The website allows prospective and
            existing clients to learn about our services, submit inquiries, and access administrative tools.
          </p>
        </section>

        {/* 2. Eligibility */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            2. Eligibility and Account Registration
          </h2>
          <ul className="space-y-3">
            {[
              "You must be at least 18 years of age and have the legal capacity to enter into a binding agreement.",
              "If registering on behalf of a company or organisation, you represent that you have authority to bind that entity to these Terms.",
              "You may authenticate using your Google account via OAuth 2.0. You are responsible for maintaining the security of your credentials and for all activity that occurs under your account.",
              "You agree to provide accurate and complete information during registration and to keep it up to date.",
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 3. Acceptable Use */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            3. Acceptable Use
          </h2>
          <p className="text-gray-700 mb-4">You agree to use the Service only for lawful purposes. You must not:</p>
          <ul className="space-y-3">
            {[
              "Violate any applicable Japanese law, regulation, or internationally recognised legal standard.",
              "Transmit any content that is defamatory, obscene, fraudulent, or otherwise objectionable.",
              "Attempt to gain unauthorised access to any part of the Service or its underlying infrastructure.",
              "Use automated tools (scrapers, bots) to access the Service without our prior written consent.",
              "Upload or transmit malware, viruses, or any other malicious code.",
              "Impersonate any person or entity, or misrepresent your affiliation with any person or entity.",
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 4. Intellectual Property */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            4. Intellectual Property Rights
          </h2>
          <p className="text-gray-700 mb-4">
            All content on the Service — including text, graphics, logos, software, and compilations — is the
            exclusive property of Dazbeez or its licensors and is protected under Japanese copyright law
            (著作権法) and applicable international treaties.
          </p>
          <p className="text-gray-700">
            We grant you a limited, non-exclusive, non-transferable, revocable licence to access and use the
            Service for personal or internal business evaluation purposes only. You may not reproduce, distribute,
            modify, create derivative works of, or commercially exploit any content without our prior written consent.
          </p>
        </section>

        {/* 5. User Content */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            5. User-Submitted Content
          </h2>
          <p className="text-gray-700">
            By submitting content through our inquiry or contact forms, you grant Dazbeez a worldwide,
            royalty-free licence to use that content solely for the purpose of responding to your inquiry
            and delivering the requested services. You retain ownership of your content and represent that
            you have all necessary rights to submit it.
          </p>
        </section>

        {/* 6. Privacy */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            6. Privacy
          </h2>
          <p className="text-gray-700">
            Your use of the Service is subject to our{" "}
            <Link href="/privacy-policy" className="text-amber-600 hover:text-amber-700 transition-colors">
              Privacy Policy
            </Link>
            , which is incorporated into these Terms by reference. By using the Service, you consent to
            the collection and use of your personal information as described in the Privacy Policy.
          </p>
        </section>

        {/* 7. Third-Party Services */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            7. Third-Party Services
          </h2>
          <p className="text-gray-700">
            The Service may integrate with third-party platforms (e.g., Google OAuth for authentication).
            Your use of such third-party services is governed by their respective terms and privacy policies.
            Dazbeez is not responsible for the practices or content of third-party services.
          </p>
        </section>

        {/* 8. Disclaimers */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            8. Disclaimers
          </h2>
          <p className="text-gray-700 mb-4">
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND,
            EITHER EXPRESS OR IMPLIED, TO THE MAXIMUM EXTENT PERMITTED BY JAPANESE LAW. DAZBEEZ SPECIFICALLY DISCLAIMS:
          </p>
          <ul className="space-y-3">
            {[
              "Any implied warranty of merchantability, fitness for a particular purpose, or non-infringement.",
              "Any warranty that the Service will be uninterrupted, error-free, or free of viruses or other harmful components.",
              "Any warranty regarding the accuracy, completeness, or timeliness of information on the Service.",
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-gray-700">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 9. Limitation of Liability */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            9. Limitation of Liability
          </h2>
          <p className="text-gray-700">
            TO THE MAXIMUM EXTENT PERMITTED BY JAPANESE LAW, DAZBEEZ AND ITS OFFICERS, DIRECTORS,
            EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
            OR PUNITIVE DAMAGES ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE. IN NO EVENT SHALL
            OUR TOTAL LIABILITY EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO DAZBEEZ IN THE 12 MONTHS
            PRECEDING THE CLAIM, OR (B) ¥10,000 JPY.
          </p>
          <p className="text-gray-700 mt-4">
            Nothing in these Terms limits liability for death, personal injury, or fraud caused by our
            gross negligence or wilful misconduct, as such limitations are prohibited under Japanese law.
          </p>
        </section>

        {/* 10. Indemnification */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            10. Indemnification
          </h2>
          <p className="text-gray-700">
            You agree to indemnify, defend, and hold harmless Dazbeez and its affiliates from any claims,
            liabilities, damages, losses, and expenses (including reasonable legal fees) arising out of or
            related to your use of the Service, your violation of these Terms, or your violation of any
            rights of a third party.
          </p>
        </section>

        {/* 11. Termination */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            11. Termination
          </h2>
          <p className="text-gray-700">
            We may suspend or terminate your access to the Service at our sole discretion, without notice,
            if you breach these Terms or if we are required to do so by law. Upon termination, your right
            to use the Service ceases immediately. Sections 4, 8, 9, 10, 12, and 13 survive termination.
          </p>
        </section>

        {/* 12. Governing Law */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            12. Governing Law and Jurisdiction
          </h2>
          <p className="text-gray-700">
            These Terms are governed by and construed in accordance with the laws of Japan, without regard
            to conflict-of-law principles. Any dispute arising out of or in connection with these Terms
            shall be subject to the exclusive jurisdiction of the Tokyo District Court (東京地方裁判所)
            as the court of first instance.
          </p>
        </section>

        {/* 13. Dispute Resolution */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            13. Dispute Resolution
          </h2>
          <p className="text-gray-700">
            Before initiating any formal legal proceedings, both parties agree to attempt to resolve any
            dispute in good faith through direct negotiation. If a dispute cannot be resolved within 30 days,
            either party may seek relief from the competent courts specified in Section 12.
          </p>
        </section>

        {/* 14. Changes */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            14. Changes to These Terms
          </h2>
          <p className="text-gray-700">
            We reserve the right to modify these Terms at any time. Material changes will be notified via
            a prominent notice on the website at least 30 days before taking effect. Your continued use
            of the Service after the effective date constitutes acceptance of the revised Terms.
          </p>
        </section>

        {/* 15. Miscellaneous */}
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
            15. Miscellaneous
          </h2>
          <ul className="space-y-3 text-gray-700">
            {[
              ["Entire Agreement", "These Terms and the Privacy Policy constitute the entire agreement between you and Dazbeez regarding the Service and supersede all prior agreements."],
              ["Severability", "If any provision of these Terms is found unenforceable, the remaining provisions remain in full force."],
              ["No Waiver", "Our failure to enforce any right or provision of these Terms does not constitute a waiver of that right."],
              ["Assignment", "You may not assign these Terms without our prior written consent. We may assign our rights and obligations without restriction."],
              ["Language", "These Terms are written in English. In the event of any conflict between the English version and any translation, the English version shall prevail."],
            ].map(([title, desc]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                <span><strong>{title}:</strong> {desc}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Contact */}
        <section className="bg-amber-50 border border-amber-200 rounded-xl p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Questions About These Terms?</h2>
          <p className="text-gray-700 mb-4">
            Please contact us at:
          </p>
          <div className="text-gray-700 space-y-1 mb-6">
            <p><strong>Dazbeez G.K. (合同会社)</strong></p>
            <p>Japan</p>
            <p>
              Email:{" "}
              <a href="mailto:legal@dazbeez.com" className="text-amber-600 hover:text-amber-700 transition-colors">
                legal@dazbeez.com
              </a>
            </p>
          </div>
          <a
            href="mailto:legal@dazbeez.com"
            className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors"
          >
            Contact Legal
          </a>
        </section>

        {/* Related */}
        <div className="flex flex-wrap gap-4 pt-4 border-t border-gray-200 text-sm text-gray-500">
          <Link href="/privacy-policy" className="text-amber-600 hover:text-amber-700 transition-colors">
            Privacy Policy →
          </Link>
          <Link href="/" className="hover:text-gray-700 transition-colors">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
