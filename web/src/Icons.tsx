import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import qrcode from "qrcode-generator";

// Byte mode carries raw UTF-8 so non-ASCII hotspot names survive scanning.
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

const ICONS: Record<string, ReactNode> = {
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <path d="M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3 3.8M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.8-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  ),
  qr: (
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
      <path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5h2.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  pressed,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="password-input">
      <input {...props} ref={input} type={visible ? "text" : "password"} spellCheck={false} autoCapitalize="off" />
      <IconButton
        icon={visible ? "eyeOff" : "eye"}
        label={visible ? "隐藏密码" : "显示密码"}
        pressed={visible}
        onClick={() => {
          setVisible(!visible);
          input.current?.focus();
        }}
      />
    </span>
  );
}

// The dashboard is served over plain http on a LAN address, where the async
// Clipboard API is unavailable; fall back to a hidden textarea copy.
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await copyText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }
  const status = state === "done" ? "已复制" : state === "failed" ? "复制失败" : "";
  return (
    <button
      type="button"
      className={`icon-button${state === "idle" ? "" : ` is-${state}`}`}
      aria-label={`复制${label}`}
      title={status || `复制${label}`}
      onClick={() => void copy()}
    >
      <Icon name={state === "done" ? "check" : state === "failed" ? "alert" : "copy"} />
      <span className="visually-hidden" role="status">
        {status}
      </span>
    </button>
  );
}

// Escapes per the ZXing WIFI: URI convention that iOS and Android cameras parse.
export function wifiQRText(ssid: string, password: string) {
  const escape = (value: string) => value.replace(/[\\;,:"]/g, (c) => `\\${c}`);
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}

export function QRCode({ text, label }: { text: string; label: string }) {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
  }
  const size = count + 8;
  return (
    <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
