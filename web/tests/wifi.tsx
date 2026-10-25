import { createRoot } from "react-dom/client";
import { WifiControl } from "../src/WifiControl";
import "../src/index.css";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation}><main className="mx-auto w-full max-w-[880px] p-4 md:p-8">
    <WifiControl />
  </main></LazyMotion></MotionConfig>,
);
