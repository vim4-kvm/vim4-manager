import { useLayoutEffect, useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { registerInlineError } from "@/stores/action";

/** Short Chinese error inside a card or page; announced as an alert. */
export function InlineError({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => registerInlineError(content.current?.textContent ?? ""));
  return (
    <Alert ref={content} variant="destructive">
      <CircleAlert />
      <AlertTitle className="font-normal">{children}</AlertTitle>
    </Alert>
  );
}
