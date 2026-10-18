import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { logout, useAccount } from "./auth";

export function AccountIcon({ kind = "person" }: { kind?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "person" ? (
        <>
          <circle cx="12" cy="7" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </>
      ) : kind === "logout" ? (
        <>
          <path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4" />
        </>
      ) : kind === "phone" ? (
        <>
          <rect x="6" y="2" width="12" height="20" rx="2" />
          <path d="M10 18h4" />
        </>
      ) : kind === "terminal" ? (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m6 9 3 3-3 3m6 0h5" />
        </>
      ) : kind === "laptop" ? (
        <>
          <rect x="4" y="3" width="16" height="13" rx="1" />
          <path d="m4 16-2 4h20l-2-4" />
        </>
      ) : (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M12 17v4m-5 0h10" />
        </>
      )}
    </svg>
  );
}

export function Avatar({ username }: { username: string }) {
  const initial = [...username][0] || "";
  return (
    <span className="account-avatar" aria-hidden="true">
      {/^\p{L}$/u.test(initial) ? initial.toUpperCase() : <AccountIcon />}
    </span>
  );
}

export function AccountLink({ compact = false }: { compact?: boolean }) {
  const { username } = useAccount();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const controller = new AbortController();
    setAddress("");
    request<{ sessions: { current: boolean; address: string }[] }>(
      "/api/account/sessions",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setAddress(value.sessions.find((device) => device.current)?.address || "");
      })
      .catch(() => {});
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("hashchange", close);
    return () => {
      controller.abort();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("hashchange", close);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch {
      setError("退出失败，请重试");
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={root} className={compact ? "account-menu-root account-link-compact" : "account-menu-root"}>
      <button
        ref={trigger}
        className={`account-trigger${open || location.hash === "#/account" ? " active" : ""}`}
        aria-label="账户菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setError("");
          setOpen(!open);
        }}
      >
        <Avatar username={username} />
        {!compact && (
          <>
            <span className="account-identity">
              <strong>{username}</strong>
              <small>管理员</small>
            </span>
            <svg className={`account-chevron${open ? " open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </>
        )}
      </button>
      {open && (
        <div
          ref={menu}
          className="account-menu"
          role="menu"
          aria-label="账户菜单"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            }
            if (event.key === "Tab") setOpen(false);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}
        >
          <div className="account-menu-heading">
            <strong>{username}</strong>
            {address && <small>本设备 {address}</small>}
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              location.hash = "/account";
            }}
          >
            <AccountIcon />
            账户与登录设备
          </button>
          <button role="menuitem" disabled={busy} onClick={() => void signOut()}>
            <AccountIcon kind="logout" />
            {busy ? "正在退出…" : "退出登录"}
          </button>
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AccountRow() {
  return (
    <div className="account-foot">
      <AccountLink />
    </div>
  );
}
