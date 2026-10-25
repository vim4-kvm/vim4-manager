import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";

/** Short Chinese error inside a card or page; announced as an alert. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle className="font-normal">{children}</AlertTitle>
    </Alert>
  );
}
