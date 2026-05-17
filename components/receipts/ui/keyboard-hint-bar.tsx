import { Fragment } from "react";
import { Kbd } from "@/components/ui/kbd";

export type KbdHint = readonly [string, string];

export function KeyboardHintBar({
  hints,
  trailing,
}: {
  hints: ReadonlyArray<KbdHint>;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-[18px] border-t border-gray-200 bg-white px-8 py-2.5 text-[11.5px] text-gray-500">
      {hints.map(([keys, label]) => (
        <span key={keys + label} className="flex items-center gap-1.5">
          {keys.split(" / ").map((k, i, arr) => (
            <Fragment key={k}>
              <Kbd>{k}</Kbd>
              {i < arr.length - 1 && (
                <span className="text-gray-300">/</span>
              )}
            </Fragment>
          ))}
          <span>{label}</span>
        </span>
      ))}
      {trailing && (
        <>
          <span className="flex-1" />
          <span>{trailing}</span>
        </>
      )}
    </div>
  );
}
