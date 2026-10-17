import { createRoot } from "react-dom/client";
import { TailscalePanel } from "../src/TailscalePanel";
import "../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <main>
    <TailscalePanel busy={false} />
  </main>,
);
