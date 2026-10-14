import { useEffect, useState } from "react";
import { request } from "./api";
import "./wifi.css";

interface WifiState {
  supported: boolean;
  enabled: boolean;
  hardwareEnabled: boolean;
}

export function WifiControl({ busy }: { busy: boolean }) {
  const [state, setState] = useState<WifiState>();
  const [error, setError] = useState("");
  const [stale, setStale] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (saving) return;
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<WifiState>(
          "/api/wifi",
          undefined,
          AbortSignal.timeout(12000),
        );
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
  }, [saving]);

  async function change(enabled: boolean) {
    setSaving(true);
    setError("");
    setConfirming(false);
    try {
      await request("/api/wifi", { enabled }, AbortSignal.timeout(25000));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Only the next status read may update the switch, including after a
      // lost response when disabling the interface carrying this session.
      setStale(true);
      setSaving(false);
    }
  }

  const disabled =
    busy || saving || stale || !state?.supported || !state.hardwareEnabled;
  const label = saving
    ? "正在切换…"
    : stale
      ? "状态暂不可用"
      : !state?.supported
        ? "未检测到无线网卡"
        : !state.hardwareEnabled
          ? "无线硬件已禁用"
          : state.enabled
            ? "已开启"
            : "已关闭";

  return (
    <section aria-labelledby="network-title">
      <div className="section-head">
        <h2 id="network-title">网络</h2>
      </div>
      <div className="app-card wifi-card">
        <div className="wifi-row">
          <div>
            <h3>Wi-Fi</h3>
            <p className="muted">
              无线接口总开关；网络名称和密码在 KVM 界面中配置。
            </p>
          </div>
          <div className="wifi-action">
            <span className="muted" role="status">
              {label}
            </span>
            <button
              type="button"
              className="wifi-switch"
              role="switch"
              aria-label="Wi-Fi"
              aria-checked={!!state?.enabled}
              disabled={disabled}
              onClick={() =>
                state?.enabled ? setConfirming(true) : void change(true)
              }
            >
              <span />
            </button>
          </div>
        </div>
        {confirming && (
          <div className="confirm" role="alertdialog" aria-label="关闭 Wi-Fi">
            <span>
              关闭会断开 Wi-Fi 连接。如果当前通过 Wi-Fi 访问，请改用有线网络。
            </span>
            <button
              className="button"
              disabled={busy || saving || stale}
              onClick={() => void change(false)}
            >
              关闭 Wi-Fi
            </button>
            <button className="button" onClick={() => setConfirming(false)}>
              取消
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
}
