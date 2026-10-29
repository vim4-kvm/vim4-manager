import { Suspense, useEffect, useState } from "react";
import { PanelSkeleton } from "./components/PanelSkeleton";
import { SettingsCard } from "./components/SettingsCard";
import { AppShell } from "./shell/AppShell";
import { pageFromHash, type PageId } from "./shell/pages";
import { pageComponent } from "./shell/routes";
import { useStatusPolling } from "./stores/status";
import { useT } from "./i18n";

function usePage(): PageId {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const change = () => setPage(pageFromHash());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return page;
}

export function App() {
  const t = useT();
  useStatusPolling();
  const page = usePage();
  const Page = pageComponent(page);
  return <AppShell page={page}>
    <Suspense fallback={<SettingsCard><PanelSkeleton label={t("common.loading")} /></SettingsCard>}>
      <Page />
    </Suspense>
  </AppShell>;
}
