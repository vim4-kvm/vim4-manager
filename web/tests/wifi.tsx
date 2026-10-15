import { createRoot } from "react-dom/client";
import { WifiControl } from "../src/WifiControl";
import "../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <main>
    <WifiControl busy={false} />
  </main>,
);
