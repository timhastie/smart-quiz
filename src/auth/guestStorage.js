// guestStorage.js
export const GUEST_STORAGE_KEY = "guest_to_merge";

export function storeGuestId(id) {
  if (typeof window === "undefined" || !id) {
    console.log("[guestStorage] storeGuestId skipped", {
      hasWindow: typeof window !== "undefined",
      id,
    });
    return;
  }
  try {
    window.localStorage.setItem(GUEST_STORAGE_KEY, id);
    console.log("[guestStorage] storeGuestId stored", {
      key: GUEST_STORAGE_KEY,
      id,
    });
  } catch (e) {
    console.warn("[guestStorage] storeGuestId error", e);
  }
}

export function readGuestId() {
  if (typeof window === "undefined") {
    console.log("[guestStorage] readGuestId no window");
    return "";
  }
  try {
    const val = window.localStorage.getItem(GUEST_STORAGE_KEY) || "";
    console.log("[guestStorage] readGuestId", {
      key: GUEST_STORAGE_KEY,
      value: val,
    });
    return val;
  } catch (e) {
    console.warn("[guestStorage] readGuestId error", e);
    return "";
  }
}

export function clearGuestId() {
  if (typeof window === "undefined") {
    console.log("[guestStorage] clearGuestId no window");
    return;
  }
  try {
    window.localStorage.removeItem(GUEST_STORAGE_KEY);
    console.log("[guestStorage] clearGuestId removed", {
      key: GUEST_STORAGE_KEY,
    });
  } catch (e) {
    console.warn("[guestStorage] clearGuestId error", e);
  }
}
