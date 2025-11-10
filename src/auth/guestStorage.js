export const GUEST_STORAGE_KEY = "guest_to_merge";

export function storeGuestId(id) {
  if (typeof window === "undefined" || !id) return;
  try {
    window.localStorage.setItem(GUEST_STORAGE_KEY, id);
  } catch {}
}

export function readGuestId() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(GUEST_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function clearGuestId() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GUEST_STORAGE_KEY);
  } catch {}
}
