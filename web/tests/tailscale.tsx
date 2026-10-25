import { createRoot } from "react-dom/client";
import { TailscalePanel } from "../src/TailscalePanel";
import "../src/index.css";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation}><main className="mx-auto w-full max-w-[880px] p-4 md:p-8">
    <TailscalePanel />
  </main></LazyMotion></MotionConfig>,
);
