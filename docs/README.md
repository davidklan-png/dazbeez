# Dazbeez Documentation

Index for the Dazbeez consulting site, its admin CRM, the receipts
reconciliation module, and the supporting networking-card and email-reply
components. Documents are grouped by role; status is noted where it can be
verified from code or accepted ADRs. Unverified PRDs/plans are filed under
**Product/Design History** rather than presented as current spec.

Start with the [root README](../README.md) for a one-page overview and
[architecture.md](architecture.md) for the system of deployable units.

---

## 1. Current Architecture

Authoritative descriptions of the system as deployed. Owner: architect + David.

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | System of Cloudflare units (main Worker, networking-card Pages, email-reply Worker, Mac MLX consumer); D1/R2/Queue bindings; auth; detailed receipts export pipeline. **Current.** |
| [README.md](../README.md) | One-page root overview: tech stack, deployable units, routes, deploy commands. **Current.** |
| [receipt-module.md](receipt-module.md) | Receipts subsystem route map. **Current (route map).** |
| [business-card-crm-architecture.md](business-card-crm-architecture.md) | `/admin` CRM + paper business-card ingestion architecture. **Current.** |
| [nfc-module.md](nfc-module.md) | `/nfc` page + networking-card system. *Reference; currentness not revalidated.* |
| [ui-ux.md](ui-ux.md) | Design system: palette, typography, component inventory, layouts. *Reference; currentness not revalidated.* |
| receipts-operating-manual-ja.pdf | Japanese operator manual for the receipts module. **Local-only operator artifact — NOT in version control (untracked); obtain from the operator.** |

## 2. Operator Runbooks

Step-by-step operational procedures. Owner: operator (David) + architect.

| Document | Description |
|----------|-------------|
| [runbooks/clerk-auth-migration.md](runbooks/clerk-auth-migration.md) | Clerk auth **migration history/status** (replaced Basic/CF Access). Not the current auth spec — for that see [architecture.md](architecture.md) and [receipt-module.md](receipt-module.md). |
| [runbooks/cf-access-app.md](runbooks/cf-access-app.md) | Cloudflare Access setup for receipts. |
| [runbooks/receipts-extraction-rollout.md](runbooks/receipts-extraction-rollout.md) | Mac-side rollout of the ADR 0001 store-and-forward extraction consumer. |
| [month-close-runbook.md](month-close-runbook.md) | Operator runbook for closing a receipts month (incl. finalize notification email). |

## 3. Decisions (ADRs)

Architecture Decision Records. Full index, status, and supersession links in
[adr/README.md](adr/README.md). New ADRs from [adr/template.md](adr/template.md).

Headline decisions: **ADR 0001** store-and-forward extraction (Mac MLX consumer),
**ADR 0002** export unit = statement month, **ADR 0005** 3–4 concurrent open
months (no hard runtime cap), **ADR 0008** calendar-month membership for
non-AMEX receipts (supersedes parts of ADR 0006).

## 4. Product / Design History and Backlog

Historical product intent and design material. **Not current spec** unless a
doc is also linked from §1; treat as context for why the system looks as it does.

| Document | Description |
|----------|-------------|
| [prd.md](prd.md) | Original marketing-site PRD (v0.1.0). **Historical** — status banner + inline notes mark obsolete claims. |
| [inquiry-workflow.md](inquiry-workflow.md) | Scripted `/inquiry` chat flow. **Historical/Retired** — route 308-redirects to `/contact`. |
| [admin-dashboard.md](admin-dashboard.md) | The **former static, unauthenticated** admin dashboard. **Historical** — `/admin` is now a live Clerk-authed CRM; see [business-card-crm-architecture.md](business-card-crm-architecture.md). |
| [dazbeez-receipt-module-prd.md](dazbeez-receipt-module-prd.md) | Receipts-module PRD. |
| [receipt_PRD_update.md](receipt_PRD_update.md) | "Simplified Capture Flow" PRD update. |
| [PRD_CaptureApp.md](PRD_CaptureApp.md) | iOS Capture-app PRD. |
| [PRD_CaptureApp_Architecture.md](PRD_CaptureApp_Architecture.md) | iOS Capture-app architecture + implementation plan. |
| [amex_requirements.md](amex_requirements.md) | AMEX / Netアンサー statement import requirements. |
| [expenseCat_Requirements.md](expenseCat_Requirements.md) | Expense-category requirements. |
| [receipt_review_feature_requests.md](receipt_review_feature_requests.md) | Receipt-review feature-request backlog. |
| [design-handoff/](design-handoff/) | Receipts UI/UX handoff package (brief, current-state, flows, open questions). |
| [AGENTS.md](../AGENTS.md) | AI-agent guidelines incl. the architect-tracked **Receipts Backlog** (items #1–#15) and the Receipts Data Lifecycle policy (per ADR 0005). |

## 5. Audits and Implementation Reports

Point-in-time audits and PR-implementation notes. Dated; read as snapshots.

| Document | Description |
|----------|-------------|
| [audits/2026-07-05-error-surfacing.md](audits/2026-07-05-error-surfacing.md) | Error-surfacing audit — 15 findings + infra gaps. |
| [audits/export-remediation-2026-07-pr-notes.md](audits/export-remediation-2026-07-pr-notes.md) | PR notes for the 2026-07-08 export remediation. |
| [audits/export-review-2026-07-08-cli-prompt.md](audits/export-review-2026-07-08-cli-prompt.md) | CLI-agent prompt for the export remediation review. |

---

## Quick Reference

### Deploy the main site

```bash
npm run build:cf
npm run deploy
bash scripts/check-deployment.sh https://dazbeez.com
```

### Development

```bash
npm run dev           # Next.js dev server (port 4488)
npm run cf:dev        # OpenNext/Workers local preview (port 8787)
cd networking-card && npm run dev   # Cloudflare Pages local (port 8788)
```

### Key routes

| URL | Purpose |
|-----|---------|
| `https://dazbeez.com/` | Home page |
| `https://dazbeez.com/services` | Services listing |
| `https://dazbeez.com/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `https://dazbeez.com/contact` | Contact form (persists to `DB`) |
| `https://dazbeez.com/admin` | Internal CRM + business-card ingestion (Clerk-authed) |
| `https://dazbeez.com/receipts` | Receipts reconciliation module (Clerk-authed) |
| `https://dazbeez.com/nfc` | NFC quick-access widget |
| `https://dazbeez.com/hi/:token` | Networking card NFC landing (Cloudflare Pages) |
