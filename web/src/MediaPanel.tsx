import { Checkbox } from "@/components/ui/checkbox";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { useEffect, useState } from "react";
import { request, type Media, type MediaImage } from "./api";
import { Disc3, ExternalLink, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/SettingRow";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { PageHeading } from "@/components/PageHeading";
import { kvmURL } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

const sources: Record<string, string> = { data: "数据盘", shared: "NanoKVM 镜像", jetkvm: "JetKVM", onekvm: "One-KVM", pikvm: "PiKVM" };
type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

export function needsMediaEject(media: Media | undefined, target: string): boolean {
  return !!media?.inserted && (target === "pikvm" || media.pikvm);
}

export function mediaName(media: Media): string {
  const nas = media.nasdisk;
  return nas ? `${nas.storageName} › ${nas.path === "/" ? "根目录" : nas.path.replace(/^\//, "")}` : media.name;
}

function size(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function MediaIcon({ cdrom, empty }: { cdrom?: boolean; empty?: boolean }) {
  const Icon = cdrom ? Disc3 : HardDrive;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${empty ? "text-muted-foreground" : "text-primary"}`} />;
}

function MediaFacts({ media }: { media: Media }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{media.nasdisk ? "NAS 文件夹" : media.cdrom ? "虚拟光盘" : "虚拟磁盘"}</span>
      <span className="rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{media.readOnly ? "只读" : "可写"}</span>
      <StatusLabel tone={media.connected ? "good" : "warning"}>
        {media.connected ? "USB 已连接" : "USB 未连接"}
      </StatusLabel>
    </span>
  );
}

export const hostEject = "在被控电脑上安全弹出此介质。Mac：访达侧栏中点击弹出按钮；Windows：使用“安全删除硬件”。仅关闭窗口或卸载卷不算弹出。";

export function MediaSummary({ media }: { media?: Media }) {
  if (media?.known && !media.inserted) return null;
  return (
    <a className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 shadow-xs dark:shadow-none" href="#/media">
      {media?.known ? (
        <>
          <MediaIcon cdrom={media.cdrom} />
          <span className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <strong>{mediaName(media)}</strong>
            <MediaFacts media={media} />
          </span>
        </>
      ) : (
        <>
          <MediaIcon empty />
          <span className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <strong>无法读取虚拟介质状态</strong>
            <span className="text-sm text-muted-foreground">状态恢复前暂不能切换界面。</span>
          </span>
        </>
      )}
      <span className="ml-auto text-xs text-link">管理介质 →</span>
    </a>
  );
}

export function MediaWait({ media, target, onCancel }: { media?: Media; target: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4" role="status">
      <div className="flex flex-wrap items-center gap-3">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        <strong>等待安全弹出后切换到 {target}</strong>
        <Button variant="outline" onClick={onCancel}>
          取消等待
        </Button>
      </div>
      {media?.inserted && (
        <p>
          <strong>{mediaName(media)}</strong> 仍挂载在被控电脑上。当前会话保持运行，检测到弹出后自动切换。
        </p>
      )}
      <p className="text-sm text-muted-foreground">{hostEject}</p>
      <p className="text-sm text-muted-foreground">最长等待 5 分钟；离开此页或连接中断会取消等待。</p>
    </div>
  );
}

function CurrentMedia({ media, locked, run }: { media?: Media; locked: boolean; run: Run }) {
  const [ejecting, setEjecting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setEjecting(false);
    setConfirmed(false);
  }, [media?.token, media?.inserted, media?.known]);

  if (!media?.known) {
    return (
      <SettingsCard title="当前介质">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 items-center justify-center rounded-full bg-muted"><HardDrive className="size-10 text-muted-foreground" aria-hidden="true" /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-medium">状态未知</h3>
            <p className="text-sm text-muted-foreground">暂时无法读取介质状态，请等待状态恢复。</p>
          </div>
        </div>
      </SettingsCard>
    );
  }
  if (!media.inserted) {
    return (
      <SettingsCard title="当前介质">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 items-center justify-center rounded-full bg-muted"><Disc3 className="size-12 text-muted-foreground" aria-hidden="true" /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-medium">未挂载介质</h3>
            <p className="text-sm text-muted-foreground">从下方镜像库选择一个镜像，挂载到被控电脑。</p>
          </div>
        </div>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard title="当前介质">
      <div className="flex flex-wrap items-center gap-5 py-2">
        <div className="flex size-24 shrink-0 items-center justify-center rounded-full border-8 border-muted bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300">{media.cdrom ? <Disc3 className="size-16" aria-hidden="true" /> : <HardDrive className="size-12" aria-hidden="true" />}</div>
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-3 [overflow-wrap:anywhere]">
          <h3 className="text-xl font-semibold tracking-tight">{mediaName(media)}</h3>
          <StatusLabel tone="good">已挂载到被控电脑</StatusLabel>
          <MediaFacts media={media} />
          {media.nasdisk?.mode === "rw" && <p className="text-sm text-muted-foreground">弹出后修改会写回 NAS，进度见「网络存储」页。</p>}
        </div>
        <div className="flex max-w-sm flex-col items-end gap-5">
        {!ejecting && (
          <Button variant="outline" disabled={locked} onClick={() => setEjecting(true)}>
            弹出…
          </Button>
        )}
        <p className="text-xs text-muted-foreground">请先在被控电脑安全弹出，再从这里移除介质。</p>
        </div>
      </div>
      <ConfirmDialog open={ejecting} onOpenChange={setEjecting} title="弹出…" confirm="弹出虚拟磁盘"
        busy={locked} disabled={!confirmed || !media.token} closeOnConfirm={false}
        onConfirm={() => {
          setConfirmed(false);
          void run("正在弹出虚拟磁盘…", () => request("/api/media/eject", { token: media.token, confirmed: true }), "虚拟磁盘已弹出");
        }}>
        <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
          <li>{hostEject}</li><li>确认主机已停止使用后，再从这里移除。</li>
        </ol>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={confirmed} disabled={locked} onCheckedChange={(value) => setConfirmed(value === true)} />
          被控电脑已停止使用磁盘并安全卸载
        </label>
        <p className="text-sm text-muted-foreground">此操作无法替代主机上的安全移除；主机仍锁定介质时会拒绝弹出。</p>
      </ConfirmDialog>
    </SettingsCard>
  );
}

export function MediaPanel() {
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const media = stale ? undefined : status?.media;
  const active = status?.active ?? "";
  const activeApp = status?.apps.find((a) => a.id === active);
  const activeName = activeApp?.name;
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const [images, setImages] = useState<MediaImage[]>([]);
  const [imageID, setImageID] = useState("");
  const [readonly, setReadonly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    request<MediaImage[]>("/api/media", undefined, controller.signal).then(setImages).catch(e => {
      if (!controller.signal.aborted) { setImages([]); setError(e.message); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const selected = images.find(image => image.id === imageID);
  const locked = busy || !media?.known;
  const readOnlyRequired = !!selected?.cdrom || active === "jetkvm";
  const groups = [...new Set(images.map(image => image.source))]
    .sort((a, b) => Object.keys(sources).indexOf(a) - Object.keys(sources).indexOf(b));
  const blocker = media?.inserted ? "先弹出当前介质，再挂载其他镜像。"
    : !activeName ? "需先启用一个 KVM 界面。"
    : !selected ? "选择一个镜像。"
    : `通过 ${activeName} 挂载，可能短暂重连 USB 键鼠。`;

  return (
    <>
      <PageHeading page="media" />
      <CurrentMedia media={media} locked={locked} run={run} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_250px]">
      <SettingsCard title="镜像库" action={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || loading} onClick={() => setReload(value => value + 1)}><RefreshCw />刷新</Button><Button variant="outline" asChild><a href="#/disks">管理数据盘<ExternalLink /></a></Button></div>}>
        {loading ? <PanelSkeleton />
          : error ? <InlineError>{error}</InlineError>
          : images.length === 0 ? (
            <EmptyState icon={Disc3}>尚无镜像。在「数据盘」页新建数据盘，或通过对应 KVM 上传 ISO/IMG 文件后刷新列表。</EmptyState>
          ) : (
            <FadeIn><div className="flex flex-col gap-5" role="radiogroup" aria-label="镜像文件">
              {groups.map(source => (
                <div key={source} className="flex flex-col gap-2 [&_h4]:flex [&_h4]:items-baseline [&_h4]:justify-between [&_h4]:text-xs [&_h4]:font-medium [&_h4]:text-muted-foreground">
                  <h4>
                    {sources[source] ?? source}
                    {source === "data" && <a className="text-xs text-link hover:underline" href="#/disks">管理文件 →</a>}
                  </h4>
                  <AnimatedList className="flex flex-col divide-y" items={images.filter(image => image.source === source)} getKey={(image) => image.id}>{(image) => (
                    <label className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-4 transition-colors hover:bg-accent/60 has-checked:bg-chart-1/7 has-disabled:cursor-default has-disabled:hover:bg-transparent [&_input]:accent-chart-1">
                      <input
                        type="radio"
                        name="media-image"
                        value={image.id}
                        checked={image.id === imageID}
                        disabled={locked}
                        onChange={() => { setImageID(image.id); setReadonly(true); }}
                      />
                      <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_6rem_4rem]">
                        <span className="flex min-w-0 items-center gap-3"><MediaIcon cdrom={image.cdrom} /><span className="min-w-0 break-all text-sm font-medium">{image.name}</span></span>
                        <span className="text-right text-xs tabular-nums text-muted-foreground">{size(image.size)}</span>
                        <span className="hidden text-right text-xs text-muted-foreground md:block">{image.cdrom ? "光盘" : "磁盘"}</span>
                      </span>
                    </label>
                  )}</AnimatedList>
                </div>
              ))}
            </div></FadeIn>
          )}
        <SettingRow title={selected ? `已选 ${selected.name}` : "选择镜像"} description={blocker} control={<>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5"
              checked={readonly || readOnlyRequired}
              disabled={locked || !!media?.inserted || readOnlyRequired}
              onCheckedChange={(value) => setReadonly(value === true)}
            />
            只读挂载{readOnlyRequired ? "（光盘或 JetKVM 必须只读）" : ""}
          </label>
          <Button variant="default" aria-label="挂载镜像"
            disabled={locked || loading || !!media?.inserted || !selected || !active}
            onClick={() => {
              if (selected) void run("正在挂载虚拟磁盘…", () => request("/api/media/mount", { app: active, image: selected.id, cdrom: selected.cdrom, readOnly: readonly || readOnlyRequired }), "虚拟磁盘已挂载");
            }}
          >
            {media?.inserted ? "先弹出当前介质" : "挂载镜像"}
          </Button>
        </>} />
      </SettingsCard>
      <SettingsCard title="镜像来源">
        <div className="space-y-4 text-sm text-muted-foreground">
          <p><strong className="font-medium text-foreground">数据盘</strong>：在数据盘页创建镜像和管理文件。</p>
          <p><strong className="font-medium text-foreground">ISO / IMG</strong>：在对应 KVM 界面上传，然后刷新镜像库。</p>
          {activeApp && <a className="inline-flex items-center gap-1 text-link hover:underline" href={kvmURL(activeApp.port, activeApp.id)}>打开 {activeApp.name}<ExternalLink className="size-3.5" /></a>}
        </div>
        <p className="text-xs text-muted-foreground">四个界面共用同一个 USB 存储设备。已有介质时，需先弹出再挂载其他镜像。</p>
      </SettingsCard>
      </div>
    </>
  );
}
