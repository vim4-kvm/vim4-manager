import { useEffect, useRef, useState } from "react";
import { wifiWrite, type Hotspot } from "./api";
import { CopyButton, IconButton, PasswordInput, QRCode, wifiQRText } from "./Icons";

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
    <div className="wifi-hotspot">
      <dl className="facts">
        <div>
          <dt>网络名称</dt>
          <dd>
            <span className="wifi-hotspot-name">
              <span className={`lamp ${hotspot.active ? "status-good" : ""}`} />
              <strong>{hotspot.ssid}</strong>
              <span className="muted">{hotspot.active ? "正在广播" : "未启动"}</span>
              {hotspot.active && <IconButton icon="qr" label="扫码连接热点" onClick={() => setSharing(true)} />}
            </span>
          </dd>
        </div>
        <div>
          <dt>密码</dt>
          <dd>
            <span className="wifi-secret">
              <code className="mono">{reveal ? hotspot.password : "•".repeat(Math.max(8, hotspot.password.length))}</code>
              <IconButton icon={reveal ? "eyeOff" : "eye"} label={reveal ? "隐藏密码" : "显示密码"} onClick={() => setReveal(!reveal)} />
              <CopyButton text={hotspot.password} label="热点密码" />
            </span>
          </dd>
        </div>
        {hotspot.active && ip && (
          <div>
            <dt>访问地址</dt>
            <dd>
              <ul className="ts-urls">
                {[
                  { label: "管理面板", url: `http://${ip}` },
                  { label: "KVM 界面", url: `http://${ip}:8080` },
                ].map(({ label, url }) => (
                  <li key={url}>
                    <span className="ts-url-label">{label}</span>
                    <span className="ts-url-value">
                      <span className="mono">{url}</span>
                      <CopyButton text={url} label={`${label}地址`} />
                    </span>
                  </li>
                ))}
              </ul>
              <span className="muted">连入热点的设备用这些地址访问；它们也能经板子的有线网络上网。</span>
            </dd>
          </div>
        )}
        <div>
          <dt>开机启动</dt>
          <dd>
            <label className="media-check">
              <input
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
          </dd>
        </div>
      </dl>

      {editing ? (
        <form
          className="wifi-hotspot-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ssidValid && passwordValid && !locked) void save();
          }}
        >
          <label className="field">
            网络名称
            <input value={ssid} spellCheck={false} autoComplete="off" aria-invalid={!ssidValid} onChange={(e) => setSSID(e.target.value)} />
            {!ssidValid && <span className="field-hint">1–32 字节，不含控制字符</span>}
          </label>
          <label className="field">
            新密码
            <PasswordInput
              value={password}
              placeholder="留空保留当前密码"
              autoComplete="new-password"
              aria-invalid={!passwordValid}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!passwordValid && <span className="field-hint">8–63 位字母、数字或符号</span>}
          </label>
          <label className="field">
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
          <p className="field-hint wifi-hotspot-note">
            {hotspot.active ? "保存后热点会重启，已连入的设备需要用新设置重新连接。" : "板子的无线网卡只支持 2.4 GHz 热点。"}
          </p>
          <div className="wifi-join-actions">
            <button type="button" className="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={locked || !ssidValid || !passwordValid}>
              保存
            </button>
          </div>
        </form>
      ) : (
        <div className="tailscale-manage">
          <button className="button small" disabled={locked} onClick={edit}>
            修改热点设置
          </button>
        </div>
      )}

      {hotspot.active && (
        <div className="ts-devices">
          <div className="ts-devices-head">
            <h4>已连入的设备</h4>
            <span className="muted">{hotspot.clients.length} 台</span>
          </div>
          {hotspot.clients.length === 0 ? (
            <p className="ts-empty muted">还没有设备连入。</p>
          ) : (
            <ul className="ts-device-list" aria-label="已连入的设备">
              {hotspot.clients.map((c) => (
                <li key={c.mac} className="wifi-client">
                  <span className="lamp status-good" />
                  <strong>{c.hostname || "未知设备"}</strong>
                  <span className="mono muted">{c.ip || "等待分配地址"}</span>
                  <span className="mono muted">{c.mac}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sharing && hotspot.active && <HotspotQR hotspot={hotspot} ip={ip} onClose={() => setSharing(false)} />}
    </div>
  );
}

function HotspotQR({ hotspot, ip, onClose }: { hotspot: Hotspot; ip: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<"join" | "panel" | "kvm">("join");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
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
    <dialog
      ref={dialog}
      className="qr-dialog"
      aria-label="扫码连接"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
    >
      <div className="qr-dialog-head">
        <h3>扫码连接</h3>
        <IconButton icon="close" label="关闭" onClick={() => dialog.current?.close()} />
      </div>
      <div className="segmented qr-steps" role="group" aria-label="二维码内容">
        {(["join", "panel", "kvm"] as const).map((id, i) => (
          <button key={id} type="button" aria-pressed={step === id} onClick={() => setStep(id)}>
            <strong>
              {i === 0 ? "① " : "② "}
              {targets[id].title}
            </strong>
          </button>
        ))}
      </div>
      <QRCode text={target.text} label={`${target.title}二维码`} />
      <p className="qr-detail mono">{target.detail}</p>
      <p className="muted qr-hint">{target.hint}</p>
    </dialog>
  );
}
