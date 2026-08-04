/** Restricts settings to trusted extension contexts when the Chrome API supports it. */
export async function lockStorage(): Promise<void> {
  if (typeof chrome.storage.local.setAccessLevel !== "function") return;

  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Storage remains usable on older or restricted Chrome builds; saving settings must not
    // depend on this defense-in-depth API succeeding.
  }
}
