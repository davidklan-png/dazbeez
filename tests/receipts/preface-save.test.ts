import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement, ReactNode } from "react";

// Use the existing review-evidence hook harness; no DOM dependency.
let states: unknown[] = [];
let cursor = 0;
let dirty = false;
let refreshes = 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const react = require("react");
require.cache[require.resolve("react")] = { exports: {
  ...react,
  useState(initial: unknown) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value: unknown) => { states[index] = value; }];
  },
  useEffect(callback: () => void) { callback(); },
  useMemo(callback: () => unknown) { return callback(); },
} } as typeof require.cache[string];
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() { refreshes++; } }) } });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrefaceEditor } = require("../../components/receipts/export/preface-editor") as typeof import("../../components/receipts/export/preface-editor");

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el as ReactElement<Record<string, unknown>>, ...elements(el.props?.children)];
}

function render() {
  cursor = 0;
  const nodes = elements(PrefaceEditor({
    month: "2026-11", initialMessage: "Saved preface", editable: true,
    noticeInput: { monthLabel: "November 2026", rowCount: 1, receiptCount: 1, missingReceiptLines: [] },
    names: null, onDirtyChange(value) { dirty = value; },
  }));
  const textarea = nodes.find(el => el.type === "textarea")!;
  const save = nodes.find(el => el.props.children === "保存" || el.props.children === "保存中…")!;
  const noMessage = nodes.find(el => el.props.children === "今月はメッセージなし")!;
  return { nodes, textarea, save, noMessage };
}

test("delayed Save and No-message lock input until acknowledgement; failed saves preserve the dirty draft", async () => {
  for (const action of ["save", "noMessage"] as const) {
    for (const ok of [true, false]) {
      states = []; refreshes = 0;
      let ui = render();
      assert.ok(!ui.textarea.props.disabled);
      (ui.textarea.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "  New preface  " } });
      ui = render();
      assert.equal(dirty, true);

      let respond!: (response: Response) => void;
      const fetch = mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { respond = resolve; }));
      try {
        const pending = (ui[action].props.onClick as () => Promise<unknown>)();
        ui = render();
        assert.equal(ui.textarea.props.disabled, true, `${action}: native disabled blocks intervening typing`);
        assert.equal(ui.save.props.disabled, true);
        assert.equal(ui.noMessage.props.disabled, true);
        assert.equal(ui.textarea.props.value, "  New preface  ");
        assert.equal(dirty, true, "finalize stays blocked before acknowledgement");
        assert.equal(refreshes, 0);
        assert.equal(fetch.mock.calls.length, 1);
        assert.equal(fetch.mock.calls[0].arguments[0], "/api/receipts/export/2026-11/message");
        const init = fetch.mock.calls[0].arguments[1] as RequestInit;
        assert.equal(init.method, "PATCH");
        assert.deepEqual(JSON.parse(init.body as string), { message: action === "save" ? "  New preface  " : "" });

        respond(Response.json(ok ? { operatorMessage: action === "save" ? "New preface" : null } : { error: "Conflicts with an active build or a sealed month." }, { status: ok ? 200 : 409 }));
        await pending;
        ui = render();
        assert.equal(ui.textarea.props.disabled, false);
        assert.equal(ui.textarea.props.value, ok ? (action === "save" ? "New preface" : "") : "  New preface  ");
        assert.equal(dirty, !ok);
        assert.equal(refreshes, ok ? 1 : 0);
        assert.equal(ui.save.props.disabled, ok);
        assert.equal(ui.noMessage.props.disabled, ok && action === "noMessage");
        if (!ok) assert.ok(ui.nodes.some(el => el.props.children === "Conflicts with an active build or a sealed month."));
      } finally {
        fetch.mock.restore();
      }
    }
  }
});
