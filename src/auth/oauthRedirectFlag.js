const FLAG_KEY = "sq_oauth_redirect";
const TTL_MS = 15000; // 15s guard so UI never gets stuck

function safeSessionStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function markOauthRedirect() {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.setItem(FLAG_KEY, String(Date.now()));
  } catch {}
}

export function clearOauthRedirect() {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.removeItem(FLAG_KEY);
  } catch {}
}

export function isOauthRedirectActive(now = Date.now()) {
  const store = safeSessionStorage();
  if (!store) return false;
  try {
    const raw = store.getItem(FLAG_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (Number.isNaN(ts)) {
      store.removeItem(FLAG_KEY);
      return false;
    }
    if (now - ts > TTL_MS) {
      store.removeItem(FLAG_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export { TTL_MS as OAUTH_REDIRECT_TTL };
