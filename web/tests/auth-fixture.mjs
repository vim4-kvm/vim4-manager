// Browser-only fixture: production authentication remains enforced by the server.
export async function authenticated(target) {
  await target.route("**/__vim4/api/auth/state", route => route.fulfill({ json: {
    configured: true, authenticated: true, username: "admin", secure: false,
    setupAllowed: true, retryAfter: 0, hostname: "vim4",
  } }));
}
