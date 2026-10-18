import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface AuthState {
  configured: boolean;
  authenticated: boolean;
  username: string;
  secure: boolean;
  setupAllowed: boolean;
  retryAfter: number;
  hostname?: string;
}

export const loginURL = () =>
  `/__vim4/login?next=${encodeURIComponent(location.pathname + location.search + (location.hash || "#/overview"))}`;

export function redirectLogin() {
  location.replace(loginURL());
}

export function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") && !/[\\\r\n\t]/.test(value) ? value : "/#/overview";
}

const AccountContext = createContext({ username: "", setUsername: (_: string) => {} });
export const useAccount = () => useContext(AccountContext);

export async function logout() {
  const response = await fetch("/__vim4/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok && response.status !== 401) throw new Error("退出失败，请重试");
  redirectLogin();
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/__vim4/api/auth/state", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const state: AuthState = await response.json();
        if (controller.signal.aborted) return;
        if (!state.authenticated) {
          redirectLogin();
        } else {
          setUsername(state.username);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="auth-shell">
        <p>无法连接板子，请检查网络后重试</p>
        <button className="button" onClick={() => location.reload()}>
          重试
        </button>
      </div>
    );
  }
  if (username === undefined) return <div className="auth-shell">正在连接…</div>;
  return <AccountContext.Provider value={{ username, setUsername }}>{children}</AccountContext.Provider>;
}
