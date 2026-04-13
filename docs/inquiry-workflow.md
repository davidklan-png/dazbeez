# Inquiry Workflow

## Overview

The inquiry flow at `/inquiry` is a chat-style interface that guides prospective clients toward the right Dazbeez service through a scripted decision tree, with a freeform text fallback for unscripted input.

- **Route:** `/inquiry`
- **Component type:** Client component (`"use client"`)
- **State management:** Local React `useState` — no server calls, no persistence

---

## User Flow

```
User arrives at /inquiry
        ↓
Assistant sends greeting + 5 option buttons
        ↓
User clicks option OR types freeform message
        ↓
   [freeform?]──────────────────────────────────────────────────┐
        ↓ (option click)                                         │
Keyword match → route to branch                                  │
        ↓                                                        │
Assistant responds with branch message + new options             │
        ↓                                    ┌────────────────────┘
   [human/schedule?]──────── YES ──→  Show contact form overlay
        ↓ NO                                 (replaces chat UI)
Continue tree → done state
        ↓
"Start over" resets to greeting
```

---

## Decision Tree

### Greeting

> "Welcome to Dazbeez! I'm here to help you find the right solution for your business. What brings you here today?"

Options:
- "I want to automate tasks" → `automate`
- "I need better data management" → `data`
- "I'm interested in AI" → `ai`
- "I need help with a project" → `project`
- "Just browsing" → `not-sure`

---

### Branch: `automate`

> "Great! Automation can save significant time and reduce errors. What type of tasks are you looking to automate?"

Options: Data entry, Customer comms, Reporting, Workflow between apps, Not sure

---

### Branch: `data`

> "Data is a valuable asset. What data challenges are you facing?"

Options: Scattered data, Better analytics, Data quality, Compliance, Building a warehouse

---

### Branch: `ai`

> "AI offers many possibilities. What AI capability interests you most?"

Options: Predictive analytics, Chatbots, Content generation, Document processing, Not sure

---

### Branch: `project`

> "We offer project management for digital initiatives. What kind of project are you planning?"

Options: Digital transformation, System integration, Data migration, New product launch, Other

---

### Branch: `not-sure`

> "That's completely fine! Our core services include AI Integration, Automation, Data Management, Governance, and Project Management. Would you like to:"

Options: Explore all services, Talk to a human, See case studies, Book a consultation

---

### Terminal: `done`

> "Thanks for sharing! Based on your needs, I recommend exploring our Automation services. Would you like to schedule a consultation?"

Options: Yes (→ `human`), Continue exploring, Start over (→ `greeting`)

---

### Terminal: `human` → Contact Form

Triggers `setShowContactForm(true)`, which replaces the entire chat UI with an inline contact form (name, email, company, message). A "← Back to chat" button dismisses the form.

---

## Keyword Routing Logic

```typescript
const lowerOption = option.toLowerCase();

if (lowerOption.includes("automat"))               → "automate"
else if (lowerOption.includes("data"))             → "data"
else if (lowerOption.includes("ai") || "predict") → "ai"
else if (lowerOption.includes("project") || "transform") → "project"
else if (lowerOption.includes("human") || "consult" || "schedule") → "human"
else if (lowerOption.includes("start over"))       → "greeting"
else                                               → "done"
```

Freeform text input bypasses keyword matching entirely — it always routes to the generic `done` response via a 1-second `setTimeout` (LLM hook placeholder).

---

## State

```typescript
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  options?: string[];  // option buttons rendered inside assistant messages
};

const [messages, setMessages]             // Message thread
const [input, setInput]                   // Text input value
const [isTyping, setIsTyping]             // Typing indicator visibility
const [showContactForm, setShowContactForm] // Contact form toggle
```

---

## UI Components

### Chat Viewport

- Height: `h-[500px] overflow-y-auto`
- User messages: right-aligned, `bg-amber-500 text-white`, `rounded-2xl`
- Assistant messages: left-aligned, `bg-gray-100 text-gray-900`, `rounded-2xl`
- Option buttons: white `bg-white text-gray-900 rounded-lg hover:bg-amber-50` rendered below assistant content

### Typing Indicator

```jsx
<div className="flex space-x-2">
  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
</div>
```

### Input Bar

Pinned to card bottom, separated by `border-t`. Enter key triggers `handleSend`. Send button disabled when input empty or while typing.

### Contact Form (Overlay)

Replaces entire page content. Fields:
- Name (required)
- Email (required)
- Company (optional)
- Message (optional)
- Submit → `alert("Thank you...")` (TODO: wire to backend)
- Back to chat button

---

## Known Limitations & TODOs

| Item | Status |
|------|--------|
| Freeform LLM responses | `setTimeout` placeholder — Ollama container reserved |
| Contact form submission | `alert()` only — no persistence or email notification |
| Scroll-to-bottom on new message | Not implemented (user must scroll manually) |
| Message IDs | Use `Date.now()` — not collision-safe under rapid clicks |
| Conversation persistence | Resets on page refresh |

---

## Extending the Script

Add new branches to the `scriptFlow` object in `app/inquiry/page.tsx`:

```typescript
const scriptFlow: Record<string, { response: string; options?: string[] }> = {
  myNewBranch: {
    response: "Here's my new response.",
    options: ["Option A", "Option B"]
  },
  // ...
};
```

Add a matching keyword rule in `handleOptionClick`:

```typescript
else if (lowerOption.includes("keyword")) nextStep = "myNewBranch";
```
