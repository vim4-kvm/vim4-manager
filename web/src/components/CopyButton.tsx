import { useEffect, useRef, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await copyText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }
  const status = state === "done" ? "已复制" : state === "failed" ? "复制失败" : "";
  return (
    <Button
      type="button"
      variant="ghost" size="icon" className="size-8"
      aria-label={`复制${label}`}
      title={status || `复制${label}`}
      onClick={() => void copy()}
    >
      {state === "done" ? <Check className="size-4" /> : state === "failed" ? <TriangleAlert className="size-4" /> : <Copy className="size-4" />}
      <span className="sr-only" role="status">
        {status}
      </span>
    </Button>
  );
}
