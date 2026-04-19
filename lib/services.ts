import type { ServiceVariant } from "@/components/hex-icon";

export type ServiceSlug = ServiceVariant;

export type Service = {
  slug: ServiceSlug;
  title: string;
  description: string;
  fullDescription: string;
  useCases: string[];
  related: [ServiceSlug, ServiceSlug];
};

export const services: Record<ServiceSlug, Service> = {
  ai: {
    slug: "ai",
    title: "AI Integration",
    description:
      "Build intelligent systems that learn from your data — from patient health assistants to Japanese-language document OCR.",
    fullDescription:
      "We design and deploy AI-powered applications tailored to your domain, integrating computer vision, large language models, and classification pipelines into production-grade workflows. Our projects include a patient health assistant and a Google Cloud Vision OCR system for Japanese receipt classification — built with a focus on privacy, accuracy, and operational reliability.",
    useCases: [
      "Patient health assistant with AI-guided symptom tracking",
      "Japanese receipt OCR using Google Cloud Vision API",
      "Multimodal document intelligence combining vision and language models",
      "Privacy-first AI design with zero full-document logging",
      "LLM integration for conversational workflows and decision support",
      "Automated compliance checks on AI-extracted data fields",
    ],
    related: ["automation", "data"],
  },
  automation: {
    slug: "automation",
    title: "Automation",
    description:
      "Replace manual workflows with reliable, self-hosted pipelines — from ETL processing to AI agent orchestration.",
    fullDescription:
      "We build automation systems that eliminate repetitive data tasks and reduce SaaS dependency. Our work includes a financial ETL pipeline for Japanese expense categorization with 91% test coverage, an AI agent framework built on OpenClaw, and a self-hosted bounty tracker that quantifies cost savings from replacing paid subscriptions with open-source alternatives.",
    useCases: [
      "ETL pipeline for Japanese credit card expense categorization with Shift-JIS/UTF-8 support",
      "SaaS cost tracker measuring open-source replacement savings (Bountymon)",
      "AI agent orchestration with the OpenClaw framework",
      "Automated attendee estimation from financial transaction amounts",
      "GitHub Actions CI/CD with 91% test coverage enforcement",
      "Self-hosted Cloudflare Pages deployment with zero recurring infrastructure costs",
    ],
    related: ["ai", "data"],
  },
  data: {
    slug: "data",
    title: "Data Management",
    description:
      "Structure, store, and audit your business data with full Japanese regulatory compliance and long-term retention.",
    fullDescription:
      "We build data management platforms that meet Japanese statutory requirements, including NTA invoice registration number validation, 7-year retention policies, and MoneyForward-compatible exports. Our receipt management system for Japanese cooperatives features Google Cloud Vision OCR, multi-user audit logging, and mobile-first capture — deployed on a FastAPI + SQLite + React stack.",
    useCases: [
      "NTA invoice registration number validation for Japanese tax compliance",
      "Seven-year data retention with automated compliant archiving",
      "MoneyForward-compatible monthly export for cooperative accounting",
      "Google Cloud Vision OCR for Japanese-language receipt capture on mobile",
      "Multi-user cooperative audit log management with tamper-evident records",
      "FastAPI + SQLite backend with React/Vite frontend for local-network deployment",
    ],
    related: ["governance", "ai"],
  },
  governance: {
    slug: "governance",
    title: "Governance",
    description:
      "Establish data policies, compliance frameworks, and privacy controls that protect your business under Japanese law.",
    fullDescription:
      "We design governance frameworks aligned to Japan's Act on the Protection of Personal Information (APPI), covering data retention policies, cross-border transfer assessments, OAuth identity governance, and security hardening. Our approach treats compliance as an engineering discipline — auditable, testable, and integrated into your development workflow from day one.",
    useCases: [
      "APPI-compliant privacy policy design for Japanese companies",
      "Data retention framework aligned to statutory requirements (7-year accounting, 90-day logs)",
      "Cross-border data transfer assessment under Article 28 of the APPI",
      "Security hardening: CORS allowlisting, rate limiting, and input validation",
      "OAuth 2.0 identity governance for web and mobile applications",
      "Audit trail implementation with tamper-evident, compliance-ready logging",
    ],
    related: ["data", "ai"],
  },
  pm: {
    slug: "pm",
    title: "Project Management",
    description:
      "Deliver technical projects with precision — from greenfield builds to production-grade handoffs.",
    fullDescription:
      "We combine hands-on engineering with structured delivery discipline. Bio_HP demonstrates our approach: a privacy-focused, rate-limited job-fit assessment tool built with Jekyll and Cloudflare Workers, enforced by git-hook test coverage requirements, production request ID verification, and strict CORS controls — clean, testable, and ready to hand off.",
    useCases: [
      "Privacy-focused application design with zero PII logging enforced by policy",
      "Git hook enforcement of test coverage standards before every commit",
      "Rate-limited Cloudflare Worker API with strict CORS origin allowlisting",
      "Resume and job-description fit scoring with real-time character counting",
      "Production verification using request IDs and cache header validation",
      "JAMstack architecture (Jekyll + Cloudflare Workers) for cost-efficient delivery",
    ],
    related: ["automation", "governance"],
  },
};

export const serviceList: Service[] = [
  services.ai,
  services.automation,
  services.data,
  services.governance,
  services.pm,
];

export const serviceSlugs: ServiceSlug[] = serviceList.map((s) => s.slug);

export function isServiceSlug(value: string | null | undefined): value is ServiceSlug {
  return !!value && value in services;
}
