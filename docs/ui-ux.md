# UI/UX

## Design System

### Brand Identity

**Name:** Dazbeez  
**Tagline:** AI, Automation & Data Solutions  
**Tone:** Professional, approachable, forward-thinking  
**Logo mark:** Amber gradient circle with white "D" initial + bee emoji (🐝) on NFC page

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `amber-400` | `#FBBF24` | Gradient highlights, ping animation |
| `amber-500` | `#F59E0B` | Primary CTA buttons, active states, service bars |
| `amber-600` | `#D97706` | Button hover, link hover |
| `gray-900` | `#111827` | Dark backgrounds (hero, footer, nav logo) |
| `gray-800` | `#1F2937` | Secondary dark backgrounds |
| `gray-700` | `#374151` | Body text, nav links |
| `gray-600` | `#4B5563` | Secondary text, descriptions |
| `gray-500` | `#6B7280` | Muted text, metadata |
| `gray-400` | `#9CA3AF` | Placeholder text, icons |
| `gray-200` | `#E5E7EB` | Card borders, dividers |
| `gray-100` | `#F3F4F6` | Subtle backgrounds (service bars, NFC footer) |
| `gray-50` | `#F9FAFB` | Section backgrounds |
| White | `#FFFFFF` | Cards, modals, input backgrounds |

**Status colors (admin only):**
- New: `blue-100 / blue-700`
- Contacted: `amber-100 / amber-700`
- Proposal: `purple-100 / purple-700`
- Won: `green-100 / green-700`
- Lost: `red-100 / red-700`

---

### Typography

**Font:** Inter (Google Fonts, `variable: --font-inter`)  
Applied via `antialiased` on `<html>`.

| Scale | Class | Usage |
|-------|-------|-------|
| Hero H1 | `text-4xl md:text-6xl font-bold` | Landing page headline |
| Page H1 | `text-4xl md:text-5xl font-bold` | Section headings |
| H2 | `text-3xl md:text-4xl font-bold` | Sub-section headings |
| H3 | `text-2xl font-semibold` | Card headings |
| H4 | `text-xl font-semibold` | Sub-card headings |
| Body large | `text-xl text-gray-600` | Lead paragraphs |
| Body | `text-base / text-gray-700` | Default prose |
| Small | `text-sm` | Labels, metadata, badges |
| XS | `text-xs` | Micro copy, timestamps |

---

### Spacing & Layout

- Max content width: `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`
- Narrow content (forms, detail pages): `max-w-4xl` or `max-w-2xl`
- Section vertical padding: `py-16` to `py-20`
- Component gap: `gap-6` to `gap-8`
- Responsive breakpoints: `md:` (768px), `lg:` (1024px)

---

### Border Radius

| Token | Usage |
|-------|-------|
| `rounded-lg` | Inputs, table rows |
| `rounded-xl` | Cards (standard), admin panels |
| `rounded-2xl` | Cards (large), modals |
| `rounded-3xl` | NFC card outer container |
| `rounded-full` | Buttons (pill), avatars, status dots |

---

### Elevation & Shadow

- Default cards: `border border-gray-200`
- Interactive cards: `hover:border-amber-400 hover:shadow-lg transition-all duration-300`
- Modal/overlay: `shadow-xl`
- NFC card: `shadow-2xl`

---

## Component Inventory

### Navigation (`components/site-navigation.tsx`)

- **Type:** Client component (requires `useState` for mobile menu)
- **Behavior:** Sticky top (`sticky top-0 z-50`), frosted glass (`bg-white/95 backdrop-blur-sm`)
- **Desktop links:** Home, Services, Get Started, Contact (amber pill CTA)
- **Mobile:** Hamburger toggle, overlay dropdown, auto-close on outside click
- **Logo:** Amber gradient circle + "Dazbeez" wordmark
- **Not linked:** `/admin`, `/nfc` (internal routes)

### Service Card (`app/page.tsx` → `ServiceCard`)

- White card, gray border, hover border-amber + shadow
- Icon (4xl), title (xl semibold), description, "Learn more →" animated chevron
- Full card is a `<Link>` to `/services/[slug]`
- Icon scales up on group hover (`group-hover:scale-110`)

### Footer (`app/layout.tsx` → `Footer`)

- Dark background (`bg-gray-900`)
- 3-column grid: Brand, Services links, Connect links
- All links hover to `amber-400`
- Copyright with dynamic year

### Buttons

| Variant | Class |
|---------|-------|
| Primary (pill) | `bg-amber-500 hover:bg-amber-600 text-white rounded-full px-8 py-3 font-semibold` |
| Primary (block) | `bg-amber-500 hover:bg-amber-600 text-white rounded-lg py-3 w-full font-semibold` |
| Ghost (pill) | `border border-white/30 hover:border-white/60 text-white rounded-full` |
| Text link | `text-amber-600 hover:text-amber-700` |
| Disabled | `bg-gray-300 cursor-not-allowed` |

### Form Inputs

```
w-full px-4 py-2 border border-gray-300 rounded-lg
focus:ring-2 focus:ring-amber-500 focus:border-transparent
```

Labels: `text-sm font-medium text-gray-700 mb-1`

---

## Page-by-Page Layout

### Home (`/`)

1. **Hero** — dark gradient bg, radial amber glow top-right, H1 with amber gradient text, two pill CTAs
2. **Services grid** — gray-50 bg, 3-col on large, 2-col medium, service cards
3. **CTA banner** — white bg, centered H2 + paragraph + large primary pill CTA

### Services (`/services`)

1. Header — centered H1 + lead paragraph
2. Services grid (same ServiceCard pattern)
3. Dark CTA block (`from-gray-900 to-gray-800 rounded-2xl`)

### Service Detail (`/services/[slug]`)

1. Back breadcrumb (`←`)
2. Icon (6xl) + H1 + description
3. Overview prose section
4. "What We Deliver" — 2-col checklist with amber checkmark bubbles
5. Amber-50 CTA block

### Inquiry (`/inquiry`)

- Dual-panel layout: centered card max-w-2xl
- Chat viewport: `h-[500px] overflow-y-auto`
- User bubbles: amber-500 right-aligned; assistant bubbles: gray-100 left-aligned
- Option buttons: white with hover amber-50, inside assistant bubbles
- Typing indicator: 3-dot bounce animation
- Input bar: pinned to bottom of card
- Contact form overlay replaces chat UI when "human" path triggered

### Contact (`/contact`)

- Centered max-w-2xl form card
- 2-col name fields, single-col everything else
- Service dropdown
- Success state: green checkmark card with "Message Sent!"
- 3-column info strip below: Email, Location, Response Time

### NFC (`/nfc`)

- Full-screen dark gradient background
- Centered max-w-sm card with `rounded-3xl shadow-2xl`
- Amber gradient header with bee emoji
- 3 action buttons (amber, dark, blue)
- Scan source attribution (from `?src=` param)
- Ping animation below card

### Admin (`/admin`)

- Server component, `robots: noindex`
- Full-width max-w-7xl container
- 4-col KPI cards → 2-col (service interest + lead table) → 2-col (activity + pending actions)
- See [admin-dashboard.md](admin-dashboard.md) for full spec

---

## Responsive Behavior

| Breakpoint | Layout Changes |
|-----------|----------------|
| Mobile (`< 768px`) | Single column grids, hamburger nav, full-width buttons |
| Tablet (`md:`) | 2-col service grids, 2-col name fields in contact form |
| Desktop (`lg:`) | 3-col service grid, 4-col KPI cards, 2-col admin sections |

---

## Motion & Animation

| Element | Animation |
|---------|-----------|
| Service card icon | `group-hover:scale-110 transition-transform` |
| Card border/shadow | `hover:border-amber-400 hover:shadow-lg transition-all duration-300` |
| "Learn more" arrow gap | `group-hover:gap-2 transition-all` |
| Typing indicator | `animate-bounce` with `delay-100` / `delay-200` stagger |
| NFC ping dot | `animate-ping` (CSS keyframe) |
| All buttons | `transition-colors` |
| Nav links | `transition-colors` |

All animations use Tailwind's default 150–300ms ease-in-out curves. No third-party animation libraries.
