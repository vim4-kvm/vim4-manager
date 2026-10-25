import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Wifi } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AnimatedList } from "@/components/AnimatedList";
import { Fact, FactGrid } from "@/components/FactGrid";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, QrCode } from "lucide-react";
import { DetailsDialog } from "@/components/DetailsDialog";
import { useState } from "react";
import { wifiWrite, type Hotspot } from "./api";
import { CopyButton } from "@/components/CopyButton";
import { IconButton } from "@/components/IconButton";
import { PasswordInput } from "@/components/PasswordInput";
import { QRCode, wifiQRText } from "@/components/QRCode";

const HOTSPOT_PSK = /^[\x20-\x7e]{8,63}$/;

export function WifiHotspot({
  hotspot,
  locked,
  act,
}: {
  hotspot: Hotspot;
  locked: boolean;
  act: (label: string, run: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ssid, setSSID] = useState("");
  const [password, setPassword] = useState("");
  const [channel, setChannel] = useState(0);
  const [sharing, setSharing] = useState(false);

  const ip = hotspot.address.split("/")[0];
  const ssidBytes = new TextEncoder().encode(ssid).length;
  const ssidValid = ssidBytes >= 1 && ssidBytes <= 32 && !/[\x00-\x1f\x7f]/.test(ssid);
  const passwordValid = password === "" || HOTSPOT_PSK.test(password);

  function edit() {
    setSSID(hotspot.ssid);
    setPassword("");
    setChannel(hotspot.channel);
    setEditing(true);
  }

  async function save() {
    const ok = await act("正在应用热点设置…", () =>
      wifiWrite("/hotspot", { ssid, password, channel, autostart: hotspot.autostart }),
    );
    if (ok) setEditing(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <FactGrid cols={1}>
        <Fact label="网络名称" value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <span className="flex min-w-0 flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
              <StatusDot tone={hotspot.active ? "good" : "idle"} />
              <strong>{hotspot.ssid}</strong>
              <span className="text-muted-foreground">{hotspot.active ? "正在广播" : "未启动"}</span>
              {hotspot.active && <IconButton icon={QrCode} label="扫码连接热点" onClick={() => setSharing(true)} />}
            </span>
          </div>} />
        <Fact label="密码" value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="font-mono break-all">{reveal ? hotspot.password : "•".repeat(Math.max(8, hotspot.password.length))}</code>
              <IconButton icon={reveal ? EyeOff : Eye} label={reveal ? "隐藏密码" : "显示密码"} onClick={() => setReveal(!reveal)} />
              <CopyButton text={hotspot.password} label="热点密码" />
            </span>
          </div>} />
        {hotspot.active && ip && (
          <Fact label="访问地址" value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
              <ul className="flex flex-col gap-2 [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:gap-x-4 [&_li]:gap-y-1">
                {[
                  { label: "管理面板", url: `http://${ip}` },
                  { label: "KVM 界面", url: `http://${ip}:8080` },
                ].map(({ label, url }) => (
                  <li key={url}>
                    <span className="min-w-16 text-xs text-muted-foreground">{label}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                      <span className="font-mono break-all">{url}</span>
                      <CopyButton text={url} label={`${label}地址`} />
                    </span>
                  </li>
                ))}
              </ul>
              <span className="text-muted-foreground">连入热点的设备用这些地址访问；它们也能经板子的有线网络上网。</span>
            </div>} />
        )}
        <Fact label="开机启动" value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
              <input className="accent-primary"
                aria-label="开机直接进入热点模式"
                type="checkbox"
                checked={hotspot.autostart}
                disabled={locked}
                onChange={(e) =>
                  void act("正在保存…", () =>
                    wifiWrite("/hotspot", {
                      ssid: hotspot.ssid,
                      password: "",
                      channel: hotspot.channel,
                      autostart: e.target.checked,
                    }),
                  )
                }
              />
              开机直接进入热点模式
            </label>
          </div>} />
      </FactGrid>

      {editing ? (
        <form
          className="grid min-w-0 gap-4 @lg:grid-cols-2 [&_select]:h-8 [&_select]:rounded-md [&_select]:border [&_select]:bg-card [&_select]:px-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ssidValid && passwordValid && !locked) void save();
          }}
        >
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            网络名称
            <Input value={ssid} spellCheck={false} autoComplete="off" aria-invalid={!ssidValid} onChange={(e) => setSSID(e.target.value)} />
            {!ssidValid && <span className="text-xs text-muted-foreground">1–32 字节，不含控制字符</span>}
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            新密码
            <PasswordInput
              value={password}
              placeholder="留空保留当前密码"
              autoComplete="new-password"
              aria-invalid={!passwordValid}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!passwordValid && <span className="text-xs text-muted-foreground">8–63 位字母、数字或符号</span>}
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            信道
            <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
              <option value={0}>自动</option>
              {Array.from({ length: 11 }, (_, i) => i + 1).map((c) => (
                <option key={c} value={c}>
                  {c}（2.4 GHz）
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground col-span-full">
            {hotspot.active ? "保存后热点会重启，已连入的设备需要用新设置重新连接。" : "板子的无线网卡只支持 2.4 GHz 热点。"}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button variant="default" type="submit" disabled={locked || !ssidValid || !passwordValid}>
              保存
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={locked} onClick={edit}>
            修改热点设置
          </Button>
        </div>
      )}

      {hotspot.active && (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 [&_h4]:font-medium">
            <h4>已连入的设备</h4>
            <span className="text-muted-foreground">{hotspot.clients.length} 台</span>
          </div>
          {hotspot.clients.length === 0 ? (
            <EmptyState icon={Wifi}>还没有设备连入。</EmptyState>
          ) : (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label="已连入的设备" items={hotspot.clients} getKey={(c) => c.mac}>{(c) => (
                <div className="flex min-w-0 flex-wrap items-center gap-3 py-3">
                  <StatusDot tone="good" />
                  <strong>{c.hostname || "未知设备"}</strong>
                  <span className="font-mono break-all text-muted-foreground">{c.ip || "等待分配地址"}</span>
                  <span className="font-mono break-all text-muted-foreground">{c.mac}</span>
                </div>
              )}</AnimatedList>
          )}
        </div>
      )}
      {sharing && hotspot.active && <HotspotQR hotspot={hotspot} ip={ip} onClose={() => setSharing(false)} />}
    </div>
  );
}

function HotspotQR({ hotspot, ip, onClose }: { hotspot: Hotspot; ip: string; onClose: () => void }) {
  const [step, setStep] = useState<"join" | "panel" | "kvm">("join");
  const targets = {
    join: { title: "连接热点", text: wifiQRText(hotspot.ssid, hotspot.password),
      hint: "用手机相机扫描，按提示加入网络。", detail: hotspot.ssid },
    panel: { title: "管理面板", text: `http://${ip}`,
      hint: "连上热点后扫描，在浏览器中打开。", detail: `http://${ip}` },
    kvm: { title: "KVM 界面", text: `http://${ip}:8080`,
      hint: "连上热点后扫描，在浏览器中打开。", detail: `http://${ip}:8080` },
  };
  const target = targets[step];
  return (
    <DetailsDialog open title="扫码连接" onOpenChange={(open) => { if (!open) onClose(); }}>
      <Segmented label="二维码内容">
        {(["join", "panel", "kvm"] as const).map((id, i) => (
          <SegmentedOption key={id} className="items-center text-center" title={`${i === 0 ? "① " : "② "}${targets[id].title}`} pressed={step === id} onClick={() => setStep(id)} />
        ))}
      </Segmented>
      <QRCode text={target.text} label={`${target.title}二维码`} />
      <p className="text-center text-sm font-mono break-all">{target.detail}</p>
      <p className="text-muted-foreground text-center text-sm">{target.hint}</p>
    </DetailsDialog>
  );
}
