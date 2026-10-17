import { useEffect, useState } from "react";
import { request, wifiWrite, type SavedWifi, type WifiNetwork, type WifiState } from "./api";
import { PasswordInput } from "./Icons";
import { WifiHotspot } from "./WifiHotspot";

type Confirm =
  | { kind: "off" }
  | { kind: "mode"; mode: "client" | "hotspot" }
  | { kind: "disconnect" }
  | { kind: "forget"; network: SavedWifi };

const PSK_PATTERN = /^([\x20-\x7e]{8,63}|[0-9a-fA-F]{64})$/;

export function SignalBars({ signal }: { signal: number }) {
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  return (
    <svg className="wifi-bars" viewBox="0 0 16 12" role="img" aria-label={`信号 ${signal}%`}>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 4} y={9 - i * 3} width="3" height={3 + i * 3} rx="0.6" className={i < level ? "on" : undefined} />
      ))}
    </svg>
  );
}

function band(frequency: number) {
  return frequency >= 5900 ? "6 GHz" : frequency >= 4900 ? "5 GHz" : "2.4 GHz";
}

export function WifiControl({ busy }: { busy: boolean }) {
  const [state, setState] = useState<WifiState>();
  const [error, setError] = useState("");
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState<Confirm>();
  const [networks, setNetworks] = useState<WifiNetwork[]>();
  const [scanning, setScanning] = useState(false);
  const [joining, setJoining] = useState<{ ssid: string; secured: boolean; hidden: boolean }>();
  const [password, setPassword] = useState("");
  const [hiddenSSID, setHiddenSSID] = useState("");
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<WifiState>("/api/wifi", undefined, AbortSignal.timeout(12000));
        if (!cancelled) {
          setState(next);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending]);

  const clientMode = !!state?.supported && state.enabled && state.hardwareEnabled && state.mode === "client";

  async function scan(rescan: boolean) {
    if (rescan) setScanning(true);
    try {
      const result = await request<{ networks: WifiNetwork[] }>(
        `/api/wifi/networks${rescan ? "?rescan=1" : ""}`,
        undefined,
        AbortSignal.timeout(20000),
      );
      setNetworks(result.networks);
    } catch (e) {
      if (rescan) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (rescan) setScanning(false);
    }
  }

  useEffect(() => {
    if (!clientMode || pending) return;
    void scan(networks === undefined);
    const timer = window.setInterval(() => void scan(false), 15000);
    return () => window.clearInterval(timer);
  }, [clientMode, pending]);

  async function act(label: string, run: () => Promise<unknown>) {
    setPending(label);
    setError("");
    setConfirming(undefined);
    try {
      await run();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      // Only the next status read may update the view, including after a
      // lost response when the change drops the link carrying this session.
      setStale(true);
      setPending("");
    }
  }

  const toggleRadio = (enabled: boolean) =>
    act(enabled ? "正在开启…" : "正在关闭…", () => request("/api/wifi", { enabled }, AbortSignal.timeout(25000)));

  async function join() {
    if (!joining) return;
    const ssid = joining.hidden ? hiddenSSID : joining.ssid;
    const ok = await act(`正在连接 ${ssid}…`, () =>
      wifiWrite("/connect", { ssid, password: joining.secured ? password : "", hidden: joining.hidden }),
    );
    if (ok) {
      setJoining(undefined);
      setPassword("");
      setHiddenSSID("");
    }
  }

  const locked = busy || !!pending || stale;
  const label = pending
    ? pending
    : stale
      ? "状态暂不可用"
      : !state?.supported
        ? "未检测到无线网卡"
        : !state.hardwareEnabled
          ? "无线硬件已禁用"
          : state.enabled
            ? "已开启"
            : "已关闭";

  const on = !!state?.supported && state.hardwareEnabled && state.enabled;
  const current = state?.current;
  const saved = state?.saved ?? [];
  const visible = (networks ?? []).filter((n) => !n.active);
  const ssidBytes = new TextEncoder().encode(hiddenSSID).length;
  const joinSSIDValid = !joining?.hidden || (ssidBytes >= 1 && ssidBytes <= 32);
  const joinPasswordValid = !joining?.secured || PSK_PATTERN.test(password);
  const hotspotName = state?.hotspot?.ssid;

  return (
    <section aria-label="Wi-Fi">
      <div className="wifi-card">
        <div className="wifi-row">
          <div>
            <h3>Wi-Fi</h3>
            <p className="muted">连接周围的无线网络，或让板子发出热点供其他设备直接连入。有线网络不受影响。</p>
          </div>
          <div className="wifi-action">
            <span className="muted" role="status">
              {pending && <span className="spinner" aria-hidden="true" />}
              {label}
            </span>
            <button
              type="button"
              className="wifi-switch"
              role="switch"
              aria-label="Wi-Fi"
              aria-checked={!!state?.enabled}
              disabled={locked || !state?.supported || !state.hardwareEnabled}
              onClick={() => (state?.enabled ? setConfirming({ kind: "off" }) : void toggleRadio(true))}
            >
              <span />
            </button>
          </div>
        </div>

        {on && state.mode && state.mode !== "off" && (
          <div className="wifi-body">
            <div className="segmented wifi-modes" role="group" aria-label="无线模式">
              <button
                type="button"
                aria-pressed={state.mode === "client"}
                disabled={locked}
                onClick={() => state.mode !== "client" && setConfirming({ kind: "mode", mode: "client" })}
              >
                <strong>连接网络</strong>
                <span>板子加入现有 Wi-Fi</span>
              </button>
              <button
                type="button"
                aria-pressed={state.mode === "hotspot"}
                disabled={locked}
                onClick={() => state.mode !== "hotspot" && setConfirming({ kind: "mode", mode: "hotspot" })}
              >
                <strong>热点</strong>
                <span>其他设备连入板子</span>
              </button>
            </div>

            {state.mode === "client" && (
              <>
                <div className="wifi-current">
                  <span className={`lamp ${current ? "status-good" : state.state === "connecting" ? "status-warning" : ""}`} />
                  {current ? (
                    <>
                      <div className="wifi-current-main">
                        <strong>{current.ssid}</strong>
                        <span className="muted">
                          {[current.ipv4, band(current.frequency), current.security || "开放网络"].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      <SignalBars signal={current.signal} />
                      <button className="button small" disabled={locked} onClick={() => setConfirming({ kind: "disconnect" })}>
                        断开
                      </button>
                    </>
                  ) : (
                    <div className="wifi-current-main">
                      <strong>{state.state === "connecting" ? "正在连接…" : "未连接"}</strong>
                      <span className="muted">从下方列表选择网络。</span>
                    </div>
                  )}
                </div>

                <div className="wifi-list-head">
                  <h4>附近的网络</h4>
                  <button className="button small" disabled={locked || scanning} aria-busy={scanning} onClick={() => void scan(true)}>
                    {scanning && <span className="spinner" aria-hidden="true" />}
                    {scanning ? "扫描中" : "重新扫描"}
                  </button>
                </div>
                {networks === undefined ? (
                  <p className="wifi-empty muted">正在扫描…</p>
                ) : visible.length === 0 ? (
                  <p className="wifi-empty muted">没有发现其他网络。</p>
                ) : (
                  <ul className="wifi-list" aria-label="附近的网络">
                    {visible.map((n) => {
                      const open = joining && !joining.hidden && joining.ssid === n.ssid;
                      return (
                        <li key={n.ssid} className={open ? "is-open" : undefined}>
                          <button
                            type="button"
                            className="wifi-network"
                            disabled={locked}
                            aria-expanded={!!open}
                            onClick={() => {
                              if (n.saved) {
                                const entry = saved.find((s) => s.ssid === n.ssid);
                                if (entry) return void act(`正在连接 ${n.ssid}…`, () => wifiWrite("/activate", { id: entry.id }));
                              }
                              setPassword("");
                              setJoining(open ? undefined : { ssid: n.ssid, secured: !!n.security, hidden: false });
                            }}
                          >
                            <SignalBars signal={n.signal} />
                            <span className="wifi-network-name">{n.ssid}</span>
                            {n.saved && <span className="tag tag-quiet">已保存</span>}
                            <span className="muted wifi-network-meta">
                              {n.security || "开放网络"} · {band(n.frequency)}
                            </span>
                          </button>
                          {open && (
                            <JoinForm
                              secured={joining.secured}
                              password={password}
                              setPassword={setPassword}
                              valid={joinPasswordValid}
                              locked={locked}
                              onCancel={() => setJoining(undefined)}
                              onJoin={() => void join()}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="wifi-links">
                  <button
                    type="button"
                    className="link-button"
                    disabled={locked}
                    onClick={() => {
                      setPassword("");
                      setHiddenSSID("");
                      setJoining(joining?.hidden ? undefined : { ssid: "", secured: true, hidden: true });
                    }}
                  >
                    加入隐藏网络
                  </button>
                  {saved.length > 0 && (
                    <button type="button" className="link-button" aria-expanded={showSaved} onClick={() => setShowSaved(!showSaved)}>
                      已保存的网络（{saved.length}）
                    </button>
                  )}
                </div>
                {joining?.hidden && (
                  <div className="wifi-hidden">
                    <label className="field">
                      网络名称（SSID）
                      <input
                        value={hiddenSSID}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!hiddenSSID && !joinSSIDValid}
                        onChange={(e) => setHiddenSSID(e.target.value)}
                      />
                    </label>
                    <label className="media-check">
                      <input
                        type="checkbox"
                        checked={!joining.secured}
                        onChange={(e) => setJoining({ ...joining, secured: !e.target.checked })}
                      />
                      开放网络（无密码）
                    </label>
                    <JoinForm
                      secured={joining.secured}
                      password={password}
                      setPassword={setPassword}
                      valid={joinPasswordValid && joinSSIDValid && !!hiddenSSID}
                      locked={locked}
                      onCancel={() => setJoining(undefined)}
                      onJoin={() => void join()}
                    />
                  </div>
                )}
                {showSaved && saved.length > 0 && (
                  <ul className="wifi-list wifi-saved" aria-label="已保存的网络">
                    {saved.map((s) => (
                      <li key={s.id}>
                        <div className="wifi-saved-row">
                          <span className="wifi-network-name">
                            {s.ssid}
                            {s.active && <span className="tag">当前</span>}
                          </span>
                          <label className="media-check">
                            <input
                              type="checkbox"
                              checked={s.autoconnect}
                              disabled={locked}
                              onChange={(e) =>
                                void act("正在保存…", () => wifiWrite("/autoconnect", { id: s.id, enabled: e.target.checked }))
                              }
                            />
                            自动连接
                          </label>
                          {!s.active && (
                            <button
                              className="button small"
                              disabled={locked}
                              onClick={() => void act(`正在连接 ${s.ssid}…`, () => wifiWrite("/activate", { id: s.id }))}
                            >
                              连接
                            </button>
                          )}
                          <button className="button small" disabled={locked} onClick={() => setConfirming({ kind: "forget", network: s })}>
                            忘记
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {state.mode === "hotspot" && state.hotspot && (
              <WifiHotspot hotspot={state.hotspot} locked={locked} act={act} />
            )}
          </div>
        )}

        {confirming && (
          <div className="confirm" role="alertdialog" aria-label={confirmTitle(confirming)}>
            <span>{confirmText(confirming, state, hotspotName)}</span>
            <button className="button" onClick={() => setConfirming(undefined)}>
              取消
            </button>
            <button className="button danger" disabled={locked} onClick={() => void runConfirm(confirming)}>
              {confirmTitle(confirming)}
            </button>
          </div>
        )}

        {error && (
          <p className="wifi-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );

  function runConfirm(c: Confirm) {
    switch (c.kind) {
      case "off":
        return toggleRadio(false);
      case "mode":
        return act(c.mode === "hotspot" ? "正在开启热点…" : "正在切换到连接网络…", () =>
          wifiWrite("/mode", { mode: c.mode, force: c.mode === "client" && !keepHotspotFallback(state) }),
        );
      case "disconnect":
        return act("正在断开…", () => wifiWrite("/disconnect", {}));
      case "forget":
        return act("正在删除…", () => wifiWrite("/forget", { id: c.network.id }));
    }
  }
}

// Restoring the hotspot only helps a session that arrived over it and has a
// saved network to try; otherwise it would block choosing a network at all.
function keepHotspotFallback(state: WifiState | undefined) {
  return !!state?.viaWifi && !!state.saved?.length;
}

function confirmTitle(c: Confirm) {
  switch (c.kind) {
    case "off":
      return "关闭 Wi-Fi";
    case "mode":
      return c.mode === "hotspot" ? "开启热点" : "切换到连接网络";
    case "disconnect":
      return "断开";
    case "forget":
      return "忘记网络";
  }
}

function confirmText(c: Confirm, state: WifiState | undefined, hotspotName?: string) {
  const via = state?.viaWifi ? "你当前正通过 Wi-Fi 访问此页面，会话会断开。" : "";
  switch (c.kind) {
    case "off":
      return "关闭会断开 Wi-Fi 连接和热点。如果当前通过 Wi-Fi 访问，请改用有线网络。";
    case "mode":
      return c.mode === "hotspot"
        ? `${via}${state?.current ? `板子将断开「${state.current.ssid}」，` : "板子将"}发出热点「${hotspotName}」。连入后访问 http://${(state?.hotspot?.address || "10.42.0.1").split("/")[0]} 打开管理面板。`
        : keepHotspotFallback(state)
          ? `${via}热点将关闭，已连入的设备会断开。板子会自动连接已保存的网络；30 秒内连不上会自动恢复热点。`
          : `${via}热点将关闭，已连入的设备会断开。${state?.saved?.length ? "板子会尝试连接已保存的网络，" : "之后可在列表中选择网络连接，"}连不上时不会恢复热点。`;
    case "disconnect":
      return `${via}断开「${state?.current?.ssid}」后不会自动重连，直到手动连接或板子重启。`;
    case "forget":
      return `删除「${c.network.ssid}」的保存密码${c.network.active ? "，并断开当前连接" : ""}。${c.network.active ? via : ""}`;
  }
}

function JoinForm(props: {
  secured: boolean;
  password: string;
  setPassword: (v: string) => void;
  valid: boolean;
  locked: boolean;
  onCancel: () => void;
  onJoin: () => void;
}) {
  return (
    <form
      className="wifi-join"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.valid && !props.locked) props.onJoin();
      }}
    >
      {props.secured && (
        <label className="field">
          密码
          <PasswordInput
            value={props.password}
            autoComplete="off"
            autoFocus
            aria-invalid={!!props.password && !props.valid}
            onChange={(e) => props.setPassword(e.target.value)}
          />
          {!!props.password && !props.valid && <span className="field-hint">8–63 位字符，或 64 位十六进制密钥</span>}
        </label>
      )}
      <div className="wifi-join-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={props.locked || !props.valid}>
          连接
        </button>
      </div>
    </form>
  );
}
