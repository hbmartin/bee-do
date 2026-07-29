/** Restricts settings to trusted extension contexts when the Chrome API supports it. */
export async function lockStorage(): Promise<void> {
  const setAccessLevel = chrome.storage.local.setAccessLevel;
  if (typeof setAccessLevel !== "function") return;

  try {
    await setAccessLevel.call(chrome.storage.local, { accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Storage remains usable on older or restricted Chrome builds; saving settings must not
    // depend on this defense-in-depth API succeeding.
  }
}
