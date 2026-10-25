import { FadeIn } from "@/components/Motion";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel, type Tone } from "@/components/StatusDot";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";
import { useCallback, useEffect, useState } from "react";
import { getUpdates, installUpdate, type Update } from "./api";
import { DevelopmentBadge } from "@/components/DevelopmentBadge";
import { isDevelopmentVersion } from "@/lib/version";


// NanoKVM, JetKVM and One-KVM install updates from their own settings page,
// which is only reachable while that application is the running one.
const SELF_SERVICE: Record<string, string> = { "vim4-nanokvm": "nanokvm", "vim4-jetkvm": "jetkvm", "vim4-onekvm": "onekvm" };

function state(update: Update): { tone: Tone; label: string } {
  if (!update.installed) return { tone: "idle", label: "未安装" };
  if (update.error) return { tone: "warning", label: update.error };
  if (update.available) return { tone: "warning", label: `可更新到 ${update.latest}` };
  if (isDevelopmentVersion(update.installed)) return { tone: "idle", label: "暂无更新的正式版" };
  return { tone: "good", label: "已是最新" };
}

export function UpdatesPanel() {
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const active = useStatusStore((s) => s.status?.active);
  const [updates, setUpdates] = useState<Update[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<string>();

  const check = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await getUpdates(signal);
      if (!signal?.aborted) (setUpdates(next), setError(undefined));
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Releases change rarely; check on open and after each installation.
    if (busy) return;
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [busy, check]);

  const install = (update: Update) => {
    setConfirming(undefined);
    const restart = update.package === "vim4-manager" ? "，面板几秒后自动重新连接" : "";
    void run(`正在下载并安装 ${update.name} ${update.latest}…`, () => installUpdate(update.package),
      `${update.name} 已更新到 ${update.latest}${restart}`);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">从各项目在 GitHub 上的最新发布检查。平台组件（内核、采集、编码）需通过组件包或镜像升级。</span>
        <Button size="sm" variant="outline" disabled={busy || checking} onClick={() => void check()}>
          {checking ? "检查中…" : "重新检查"}
        </Button>
      </div>
      {error && <InlineError>检查失败：{error}</InlineError>}
      {!updates ? (
        !error && <PanelSkeleton />
      ) : (
        <SettingsCard label="更新"><FadeIn className="min-w-0 overflow-auto"><table className="w-full text-left text-sm [&_th]:pb-3 [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-t [&_td]:py-3 [&_td]:pr-3">
          <thead>
            <tr>
              <th>项目</th>
              <th className="hidden md:table-cell">已安装</th>
              <th>状态</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {updates.map((update) => {
              const { tone, label } = state(update);
              return (
                <tr key={update.package}>
                  <td>
                    <span className="flex flex-wrap items-center gap-2 font-medium">{update.name}<DevelopmentBadge version={update.installed} /></span>
                    <a className="font-mono break-all text-muted-foreground" href={`https://github.com/vim4-kvm/${update.repo}/releases`} target="_blank" rel="noreferrer">
                      {update.repo}
                    </a>
                  </td>
                  <td className="font-mono break-all text-muted-foreground hidden md:table-cell text-xs">{update.installed || "—"}</td>
                  <td>
                    <StatusLabel tone={tone}>
                      {label}
                    </StatusLabel>
                    {update.available && update.selfService && active !== SELF_SERVICE[update.package] && (
                      <span className="text-muted-foreground mt-1 block text-xs">切换到 {update.name} 后在其设置中更新</span>
                    )}
                  </td>
                  <td className="text-right">
                    {update.available && update.selfService && active === SELF_SERVICE[update.package] && (
                      <Button asChild variant="outline" size="sm"><a href={`${location.protocol}//${location.hostname}:8080/?kvm=${active}`}>
                        在 {update.name} 中更新
                      </a></Button>
                    )}
                    {update.available && !update.selfService && (
                      confirming === update.package ? (
                        <ConfirmDialog open title={`确认更新 ${update.name}`} confirm="更新" disabled={busy}
                          description={update.package === "vim4-pikvm" ? "PiKVM 运行中会重启。" : "管理面板会重启。"}
                          onOpenChange={(open) => { if (!open) setConfirming(undefined); }} onConfirm={() => install(update)} />
                      ) : (
                        <Button size="sm" variant="default" disabled={busy} onClick={() => setConfirming(update.package)}>
                          更新
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></FadeIn></SettingsCard>
      )}
    </>
  );
}
