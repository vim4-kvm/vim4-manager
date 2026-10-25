import { useEffect, useState } from "react";
import { AccountPanel } from "./AccountPanel";
import { DiskPanel } from "./DiskPanel";
import { MediaPanel } from "./MediaPanel";
import { StoragePanel } from "./StoragePanel";
import { TailscalePanel } from "./TailscalePanel";
import { WifiControl } from "./WifiControl";
import { KernelPanel } from "./KernelPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { SettingsCard } from "./components/SettingsCard";
import { Applications } from "./pages/Applications";
import { Cooling } from "./pages/Cooling";
import { Overview } from "./pages/Overview";
import { PassthroughPanel } from "./pages/PassthroughPanel";
import { Services } from "./pages/Services";
import { Video } from "./pages/Video";
import { AppShell } from "./shell/AppShell";
import { pageFromHash, type PageId } from "./shell/pages";
import { useStatusPolling } from "./stores/status";

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
  useStatusPolling();
  const page = usePage();
  return <AppShell page={page}>
    {page === "overview" && <Overview />}
    {page === "output" && <PassthroughPanel />}
    {page === "apps" && <Applications />}
    {page === "video" && <Video />}
    {page === "media" && <MediaPanel />}
    {page === "disks" && <DiskPanel />}
    {page === "storage" && <StoragePanel />}
    {page === "cooling" && <Cooling />}
    {page === "services" && <Services />}
    {page === "account" && <AccountPanel />}
    {page === "network" && <><WifiControl /><TailscalePanel /></>}
    {page === "updates" && <>
      <SettingsCard title="内核" description="切换 5.15 与 7.x，共用当前系统数据。"><KernelPanel /></SettingsCard>
      <UpdatesPanel />
    </>}
  </AppShell>;
}
