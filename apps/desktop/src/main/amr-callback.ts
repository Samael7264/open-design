import type { App } from "electron";

const AMR_CALLBACK_SCHEME = "open-design";
const AMR_CALLBACK_HOST = "amr-callback";

export function isAmrCallbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === `${AMR_CALLBACK_SCHEME}:` &&
      (parsed.hostname === AMR_CALLBACK_HOST ||
        parsed.pathname.replace(/^\/+/, "") === AMR_CALLBACK_HOST)
    );
  } catch {
    return false;
  }
}

function amrCallbackPayload(rawUrl: string): Record<string, string> {
  const parsed = new URL(rawUrl);
  return Object.fromEntries(parsed.searchParams.entries());
}

export async function forwardAmrCallbackUrl(
  rawUrl: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!isAmrCallbackUrl(rawUrl)) return false;
  const target = new URL("/api/integrations/amr/callback", apiBaseUrl);
  const response = await fetchImpl(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(amrCallbackPayload(rawUrl)),
  });
  return response.ok;
}

export function registerAmrCallbackProtocol(
  electronApp: App,
  discoverApiBaseUrl: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): void {
  try {
    electronApp.setAsDefaultProtocolClient(AMR_CALLBACK_SCHEME);
  } catch (error) {
    console.warn("[amr] failed to register callback protocol:", error);
  }

  const handle = (rawUrl: string): void => {
    void discoverApiBaseUrl()
      .then((apiBaseUrl) => {
        if (!apiBaseUrl) {
          console.warn("[amr] cannot forward callback before daemon URL is available");
          return false;
        }
        return forwardAmrCallbackUrl(rawUrl, apiBaseUrl, fetchImpl);
      })
      .catch((error) => {
        console.warn("[amr] failed to forward callback:", error);
      });
  };

  electronApp.on("open-url", (event, rawUrl) => {
    if (!isAmrCallbackUrl(rawUrl)) return;
    event.preventDefault();
    handle(rawUrl);
  });

  const initialCallbackUrl = process.argv.find(isAmrCallbackUrl);
  if (initialCallbackUrl) handle(initialCallbackUrl);
}
