export const TRELLIUM_PROJECT = "trellium" as const;

const VERCEL_OWNER_SUFFIX = "-hbmartins-projects.vercel.app";

export function resolveProject(urlValue: string): typeof TRELLIUM_PROJECT | null {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return null;

    const hostname = url.hostname.toLowerCase();
    if (hostname === "trellium.ai") return TRELLIUM_PROJECT;
    if (hostname.endsWith(VERCEL_OWNER_SUFFIX) && hostname.length > VERCEL_OWNER_SUFFIX.length) {
      return TRELLIUM_PROJECT;
    }
  } catch {
    return null;
  }

  return null;
}
export function isSupportedPage(urlValue: string): boolean {
  return resolveProject(urlValue) !== null;
}
