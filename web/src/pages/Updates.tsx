import { KernelPanel } from "@/KernelPanel";
import { SettingsCard } from "@/components/SettingsCard";
import { UpdatesPanel } from "@/UpdatesPanel";

export function Updates() {
  return <>
    <SettingsCard title="内核" description="切换 5.15 与 7.x，共用当前系统数据。"><KernelPanel /></SettingsCard>
    <UpdatesPanel />
  </>;
}
