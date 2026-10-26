import brand from "@/assets/brand.svg";
import { cn } from "@/lib/utils";

/** The white plate keeps the approved black-and-blue mark legible in both themes. */
export function BrandMark({ className }: { className?: string }) {
  return <img src={brand} alt="" aria-hidden="true" width={32} height={32}
    className={cn("size-8 shrink-0", className)} />;
}
