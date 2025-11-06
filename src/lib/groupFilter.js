// src/lib/groupFilter.js
export const ALL_GROUP_ID = "00000000-0000-0000-0000-000000000000";
export const NO_GROUP_ID  = "NO_GROUP"; // use whatever you already use for “No Group”
const LAST_GROUP_KEY = "sq:lastGroupFilter";

/** Read group from URL (?group=...), else from localStorage, else default ALL */
export function getInitialGroupFromUrlOrStorage(search) {
  const params = new URLSearchParams(search || "");
  const fromUrl = params.get("group");
  if (fromUrl) {
    localStorage.setItem(LAST_GROUP_KEY, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(LAST_GROUP_KEY);
  return stored || ALL_GROUP_ID;
}

/** Persist selected group to localStorage */
export function persistLastGroup(groupId) {
  localStorage.setItem(LAST_GROUP_KEY, groupId);
}

/** Build a dashboard path that restores a group selection */
export function dashboardPathForGroup(groupId) {
  const g = groupId || localStorage.getItem(LAST_GROUP_KEY) || ALL_GROUP_ID;
  return `/?group=${encodeURIComponent(g)}`;
}
