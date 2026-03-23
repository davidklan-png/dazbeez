"use client";

import { useState } from "react";
import Link from "next/link";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  options?: string[];
};

const scriptFlow: Record<string, { response: string; options?: string[] }> = {
  greeting: {
    response: "Welcome to Dazbeez! I'm here to help you find the right solution for your business. What brings you here today?",
    options: [
      "I want to automate tasks",
      "I need better data management",
      "I'm interested in AI",
      "I need help with a project",
      "Just browsing"
    ]
  },
  "automate": {
    response: "Great! Automation can save significant time and reduce errors. What type of tasks are you looking to automate?",
    options: [
      "Data entry and processing",
      "Customer communications",
      "Reporting and dashboards",
      "Workflow between apps",
      "Not sure yet"
    ]
  },
  data: {
    response: "Data is a valuable asset. What data challenges are you facing?",
    options: [
      "Too much scattered data",
      "Need better analytics",
      "Data quality issues",
      "Compliance and governance",
      "Building a data warehouse"
    ]
  },
  ai: {
    response: "AI offers many possibilities. What AI capability interests you most?",
    options: [
      "Predictive analytics",
      "Chatbots/customer service",
      "Content generation",
      "Document processing",
      "Not sure where to start"
    ]
  },
  project: {
    response: "We offer project management for digital initiatives. What kind of project are you planning?",
    options: [
      "Digital transformation",
      "System integration",
      "Data migration",
      "New product launch",
      "Other"
    ]
  },
  "not-sure": {
    response: "That's completely fine! Our core services include AI Integration, Automation, Data Management, Governance, and Project Management. Would you like to:",
    options: [
      "Explore all services",
      "Talk to a human",
      "See case studies",
      "Book a consultation"
    ]
  },
  "human": {
    response: "I'll connect you with our team. Please provide your details and we'll be in touch within 24 hours.",
    options: []
  },
  done: {
    response: "Thanks for sharing! Based on your needs, I recommend exploring our Automation services. Would you like to schedule a consultation?",
    options: ["Yes, schedule consultation", "Continue exploring", "Start over"]
  }
};

export default function InquiryPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content: scriptFlow.greeting.response,
      options: scriptFlow.greeting.options
    }
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);

  const handleOptionClick = (option: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: option
    };

    let nextStep = "not-sure";
    const lowerOption = option.toLowerCase();

    // Simple keyword matching for routing
    if (lowerOption.includes("automat")) nextStep = "automate";
    else if (lowerOption.includes("data")) nextStep = "data";
    else if (lowerOption.includes("ai") || lowerOption.includes("predict")) nextStep = "ai";
    else if (lowerOption.includes("project") || lowerOption.includes("transform")) nextStep = "project";
    else if (lowerOption.includes("human") || lowerOption.includes("consult") || lowerOption.includes("schedule")) nextStep = "human";
    else if (lowerOption.includes("start over")) nextStep = "greeting";
    else nextStep = "done";

    if (nextStep === "human") {
      setShowContactForm(true);
    }

    const assistantResponse: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: scriptFlow[nextStep]?.response || "Let me connect you with our team for more details.",
      options: scriptFlow[nextStep]?.options
    };

    setMessages((prev) => [...prev, userMessage, assistantResponse]);
  };

  const handleSend = () => {
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input
    };

    setIsTyping(true);
    setInput("");

    // Simulate LLM fallback for unscripted input
    setTimeout(() => {
      const assistantResponse: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Thanks for sharing that about "${input}". Based on what you've told me, I'd recommend exploring our services in more detail. Would you like to:`,
        options: ["Explore services", "Talk to a human", "Start over"]
      };

      setMessages((prev) => [...prev, userMessage, assistantResponse]);
      setIsTyping(false);
    }, 1000);
  };

  if (showContactForm) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center py-12">
        <div className="max-w-md w-full mx-4">
          <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Get in Touch</h2>
            <p className="text-gray-600 mb-6">Fill out the form below and we'll respond within 24 hours.</p>

            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); alert("Thank you! We'll be in touch soon."); }}>
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  id="name"
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  placeholder="Your name"
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  id="email"
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label htmlFor="company" className="block text-sm font-medium text-gray-700 mb-1">Company (optional)</label>
                <input
                  type="text"
                  id="company"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  placeholder="Your company"
                />
              </div>

              <div>
                <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">How can we help?</label>
                <textarea
                  id="message"
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-none"
                  placeholder="Tell us about your project..."
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg transition-colors"
              >
                Send Message
              </button>

              <button
                type="button"
                onClick={() => setShowContactForm(false)}
                className="w-full py-2 text-gray-600 hover:text-gray-800 transition-colors"
              >
                ← Back to chat
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center py-12">
      <div className="max-w-2xl w-full mx-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-2">
            Tell Us About Your Needs
          </h1>
          <p className="text-gray-600">Answer a few questions to find the right solution</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
          {/* Chat Messages */}
          <div className="h-[500px] overflow-y-auto p-6 space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                    message.role === "user"
                      ? "bg-amber-500 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  <p>{message.content}</p>
                  {message.options && message.options.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {message.options.map((option) => (
                        <button
                          key={option}
                          onClick={() => handleOptionClick(option)}
                          className="block w-full text-left px-4 py-2 bg-white text-gray-900 rounded-lg hover:bg-amber-50 transition-colors text-sm"
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl px-4 py-3">
                  <div className="flex space-x-2">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-gray-200 p-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && handleSend()}
                placeholder="Type your message..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping}
                className="px-6 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
              >
                Send
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2 text-center">
              Or click an option above for quick responses
            </p>
          </div>
        </div>

        <div className="text-center mt-6">
          <Link href="/" className="text-amber-600 hover:text-amber-700">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
