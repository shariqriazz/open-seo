import type { BrowserRun } from "@cloudflare/workers-types";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { parseDataforseoLighthousePayload } from "@/server/lib/dataforseoLighthousePayload";
import type { StoredLighthousePayload } from "@/server/lib/lighthouseStoredPayload";
import { readTextUpTo } from "./html-response";

/**
 * The standalone Docker stack's own Chromium (scripts/celld/runtime/browser-gateway.mjs), set
 * up by scripts/celld/runtime/configure.mjs as BROWSER_GATEWAY_URL. It renders
 * pages for JavaScript audits and runs Lighthouse, so neither needs a paid
 * provider. Unset everywhere else, where these return null and the provider
 * paths run as before.
 */
async function gateway(): Promise<{ url: string; secret: string } | null> {
  const url = await getOptionalEnvValue("BROWSER_GATEWAY_URL");
  if (!url) return null;
  const secret = await getOptionalEnvValue("CRAWL_GATEWAY_SECRET");
  if (!secret) throw new Error("CRAWL_GATEWAY_SECRET is required");
  return { url, secret };
}

/** Whether this deployment runs its own browser service. */
export async function hasLocalBrowser(): Promise<boolean> {
  return Boolean(await getOptionalEnvValue("BROWSER_GATEWAY_URL"));
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response | null> {
  const target = await gateway();
  if (!target) return null;
  return fetch(new URL(path, target.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-browser-secret": target.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Stands in for the Cloudflare Browser Run binding: `quickAction("content")`
 * answers the same JSON, so rendered-page.ts reads it unchanged.
 */
export async function getLocalBrowser(): Promise<Pick<
  BrowserRun,
  "quickAction"
> | null> {
  if (!(await gateway())) return null;
  const quickAction = async (action: string, options: unknown) => {
    // One retry when the request never reached the service (a dropped
    // connection, not a page the browser failed to load).
    const response = await post(`/${action}`, options, 90_000).catch(() =>
      post(`/${action}`, options, 90_000),
    );
    if (!response) throw new Error("Local browser is not configured");
    return response;
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a global fetch Response carries the same body and status the binding's does
  return { quickAction } as unknown as Pick<BrowserRun, "quickAction">;
}

// Lighthouse reports run to several MB before the service trims them.
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/**
 * One Lighthouse check on the local browser, reduced to the payload OpenSEO
 * stores, or null when this deployment has no local browser. The service
 * runs four checks at once and an audit sends at most four (two URLs, mobile
 * and desktop), so none waits behind another.
 */
export async function runLocalLighthouse(
  url: string,
  strategy: "mobile" | "desktop",
): Promise<StoredLighthousePayload | null> {
  const response = await post("/lighthouse", { url, strategy }, 270_000);
  if (!response) return null;
  const text = await readTextUpTo(response, MAX_REPORT_BYTES);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parsed below by the DataForSEO report parser
  const body = JSON.parse(text) as { success?: boolean; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Local Lighthouse HTTP ${response.status}`);
  }
  // The local report is the `result` DataForSEO wraps a Lighthouse run in.
  return parseDataforseoLighthousePayload(
    { status_code: 20000, tasks: [{ status_code: 20000, result: [body] }] },
    { url, strategy },
  );
}
