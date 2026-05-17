"use client";

import { useEffect } from "react";

export type ShortcutHandler = (event: KeyboardEvent) => void;
export type ShortcutMap = Record<string, ShortcutHandler>;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(
  shortcuts: ShortcutMap,
  options: { enabled?: boolean; allowInInputs?: ReadonlyArray<string> } = {},
) {
  const { enabled = true, allowInInputs = [] } = options;

  useEffect(() => {
    if (!enabled) return;

    function onKey(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const handler = shortcuts[key];
      if (!handler) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) && !allowInInputs.includes(key)) return;
      handler(event);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, enabled, allowInInputs]);
}
