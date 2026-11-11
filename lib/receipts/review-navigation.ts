// Client-safe awaited-navigation guard for the receipt review screen.
//
// The review form (form-pane) owns the pending-edit state (debounce timer +
// serialized save queue). Every navigation that can leave the form — Skip,
// the `s` save-and-next, j/k + arrow keys, rail item clicks, the compare and
// view-in-month links, the SubHeader month/scope/filter controls and the
// cross-month search — must WAIT for the latest save to commit before
// routing, and must NOT route when that save fails (the operator stays on
// the receipt, the form keeps its edits, the save badge shows the error).
// Those callers live in different components, so the single mounted form
// registers one flusher here and the callers await it through
// guardedNavigate()/guardedLinkClick().
//
// While no form is mounted (e.g. the rail on the review LIST page) there is
// nothing to flush — navigation runs immediately, unchanged.
//
// ponytail: browser-level exits (back button, reload, tab close) cannot be
// awaited from SPA code and are NOT covered here; form-pane keeps a separate
// send-and-hope unmount flush as base-parity for those. No unload dialogs.

type SaveFlusher = () => Promise<void>;

let activeFlusher: SaveFlusher | null = null;

/** The mounted review form registers its flush; the returned function
 * unregisters it (form unmount). Registering replaces any previous flusher —
 * only one review form is mounted at a time. */
export function registerSaveFlusher(flusher: SaveFlusher): () => void {
  activeFlusher = flusher;
  return () => {
    if (activeFlusher === flusher) activeFlusher = null;
  };
}

/**
 * Await pending review-form edits, then navigate. Resolves true after the
 * push. Resolves false WITHOUT navigating when the save failed — the caller
 * does nothing further; the still-mounted form surfaces the error badge and
 * retains the operator's edits.
 *
 * Multiple rapid intents (j j j, a month pick then a search while the save
 * is still committing) are coalesced by SUPERSESSION: only the LATEST
 * registered intent may push, and only after its own flush succeeds. An
 * older intent resolves false without pushing — its target would be stale
 * by the time the shared flush resolves.
 */
let navigating: object | null = null;

export async function guardedNavigate(push: () => void): Promise<boolean> {
  if (!activeFlusher) {
    push();
    return true;
  }
  const token = {};
  navigating = token; // supersedes any in-flight guarded navigation
  try {
    await activeFlusher();
  } catch {
    if (navigating === token) navigating = null;
    return false;
  }
  if (navigating !== token) return false; // superseded by a newer intent
  navigating = null;
  push();
  return true;
}

/** Structural subset of React's MouseEvent<HTMLAnchorElement> — keeps the
 * helper testable without a DOM. */
interface LinkClickEvent {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
}

/**
 * Link onClick helper: modifier clicks (⌘/Ctrl/Shift/Alt) and non-left
 * buttons keep the browser's native behavior — open in new tab/window must
 * NOT be intercepted. Plain left clicks are prevented and routed through the
 * awaited guard, pushing the SAME href the Link would have navigated to.
 */
export function guardedLinkClick(
  event: LinkClickEvent,
  href: string,
  push: (url: string) => void,
): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void guardedNavigate(() => push(href));
}
