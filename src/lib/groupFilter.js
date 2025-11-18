// src/lib/groupFilter.js
export const ALL_GROUP_ID = "00000000-0000-0000-0000-000000000000";
const LAST_GROUP_KEY = "sq:lastGroupFilter";

/** Read group from URL (?group=...), else from localStorage, else default to "" (All) */
export function getInitialGroupFromUrlOrStorage(search) {
  const params = new URLSearchParams(search || "");
  const fromUrl = params.get("group");
  if (fromUrl !== null) {
    const normalized = fromUrl === ALL_GROUP_ID ? "" : fromUrl;
    localStorage.setItem(LAST_GROUP_KEY, normalized);
    return normalized;
  }
  const stored = localStorage.getItem(LAST_GROUP_KEY);
  if (!stored || stored === ALL_GROUP_ID) {
    if (stored === ALL_GROUP_ID) {
      localStorage.setItem(LAST_GROUP_KEY, "");
    }
    return "";
  }
  return stored;
}

/** Persist selected group to localStorage */
export function persistLastGroup(groupId) {
  const normalized = groupId || "";
  localStorage.setItem(LAST_GROUP_KEY, normalized);
}

/** Build a dashboard path that restores a group selection */
export function dashboardPathForGroup(groupId) {
  const stored = groupId ?? localStorage.getItem(LAST_GROUP_KEY) ?? "";
  const normalized = stored === ALL_GROUP_ID ? "" : stored;
  return normalized ? `/?group=${encodeURIComponent(normalized)}` : "/";
}
