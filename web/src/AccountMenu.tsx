
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
