import { TailscalePanel } from "@/TailscalePanel";
import { WifiControl } from "@/WifiControl";

export function Network() {
  return <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2"><WifiControl /><TailscalePanel /></div>;
}
