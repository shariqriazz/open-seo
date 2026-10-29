// Local Chromium for the standalone stack: JavaScript rendering for site
// audits (POST /content, shaped like Cloudflare Browser Run's quick action) and
// Lighthouse checks (POST /lighthouse, the report DataForSEO would return).
//
// Pages decide what the browser requests, so Chromium reaches the network only
// through the egress proxy below. The proxy resolves each host itself, refuses
// any private or reserved address (the crawl gateway's list), and connects to
// the address it checked, so a page cannot rebind a name to an internal
// service between the check and the connection.
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { isPublicAddress, resolveTarget } from "./crawl-gateway.mjs";

const PROXY_PORT = 3128;
// Matches the crawl's four open fetches and the audit's four checks per wave.
const MAX_RENDERS = 4;
const MAX_LIGHTHOUSE = 4;
const MAX_RENDER_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
// Image payloads Lighthouse embeds; OpenSEO keeps only scores and issues.
const DROPPED_AUDITS = [
  "final-screenshot",
  "screenshot-thumbnails",
  "full-page-screenshot",
];

async function publicAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("non-public address");
  return addresses[0];
}

// Forward proxy for Chromium: absolute-URI HTTP requests and CONNECT tunnels.
function createEgressProxy() {
  const server = createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url);
      if (url.protocol !== "http:") throw new Error("unsupported");
      const { address, family } = await publicAddress(url.hostname);
      const upstream = httpRequest(
        url,
        {
          method: incoming.method,
          headers: incoming.headers,
          agent: false,
          lookup: (_hostname, _options, callback) =>
            callback(null, address, family),
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      incoming.pipe(upstream);
    } catch {
      response.writeHead(403).end();
    }
  });
  server.on("connect", async (incoming, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const [hostname, port] = splitHostPort(incoming.url);
      const { address } = await publicAddress(hostname);
      const upstream = connect({ host: address, port }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  return server;
}

function splitHostPort(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value ?? "");
  if (!match) throw new Error("bad CONNECT target");
  return [match[1], Number(match[2])];
}

const CHROME_ARGS = [
  `--proxy-server=http://127.0.0.1:${PROXY_PORT}`,
  // Without this Chromium sends loopback requests around the proxy.
  "--proxy-bypass-list=<-loopback>",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  // The container is the sandbox: Chromium's own needs privileges Docker
  // does not grant by default.
  "--no-sandbox",
];

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const launch = () =>
  puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: CHROME_ARGS,
  });

function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// One browser for renders, relaunched if it dies; each render gets its own
// incognito context so pages share no cookies or storage.
let renderBrowser;
async function getRenderBrowser() {
  if (!renderBrowser?.connected) renderBrowser = await launch();
  return renderBrowser;
}

async function renderContent({ url, gotoOptions }) {
  const target = (await resolveTarget(url)).url.href;
  const timeout = Math.min(
    Number(gotoOptions?.timeout) || 30_000,
    MAX_RENDER_TIMEOUT_MS,
  );
  const waitUntil = gotoOptions?.waitUntil === "load" ? "load" : "networkidle2";
  const browser = await getRenderBrowser();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const response = await page.goto(target, { waitUntil, timeout });
    if (!response) throw new Error("no response");
    return {
      success: true,
      result: await page.content(),
      meta: {
        status: response.status(),
        finalUrl: page.url(),
        headers: response.headers(),
      },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// Each check runs the Lighthouse CLI in its own process with its own Chromium.
// Lighthouse keeps timing marks per process, so concurrent runs in one process
// fail with "performance mark has not been set", and concurrent runs in one
// browser disturb each other's measurements.
const LIGHTHOUSE_CLI = createRequire(import.meta.url).resolve(
  "lighthouse/cli/index.js",
);
const LIGHTHOUSE_TIMEOUT_MS = 240_000;

function lighthouseCli(target, strategy) {
  const args = [
    LIGHTHOUSE_CLI,
    target,
    "--output=json",
    "--output-path=stdout",
    "--quiet",
    `--only-categories=${CATEGORIES.join(",")}`,
    `--chrome-flags=--headless=new ${CHROME_ARGS.join(" ")}`,
    ...(strategy === "desktop" ? ["--preset=desktop"] : []),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        env: { ...process.env, CHROME_PATH: CHROMIUM_PATH },
        timeout: LIGHTHOUSE_TIMEOUT_MS,
        maxBuffer: 128 * 1024 * 1024,
      },
      (error, stdout) => {
        // A page Lighthouse cannot load still prints a report naming the
        // runtime error, with a non-zero exit.
        if (stdout.trim()) {
          try {
            resolve(JSON.parse(stdout));
            return;
          } catch {
            // Fall through to the process error.
          }
        }
        reject(error ?? new Error("Lighthouse printed no report"));
      },
    );
  });
}

async function runLighthouse({ url, strategy }) {
  const target = (await resolveTarget(url)).url.href;
  const lhr = await lighthouseCli(target, strategy);
  if (lhr.runtimeError?.code) {
    const error = new Error(
      `Lighthouse encountered an error with the following code: ${lhr.runtimeError.code}`,
    );
    error.status = 422;
    throw error;
  }
  const audits = { ...lhr.audits };
  for (const id of DROPPED_AUDITS) delete audits[id];
  return {
    requestedUrl: lhr.requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.mainDocumentUrl ?? target,
    lighthouseVersion: lhr.lighthouseVersion,
    categories: lhr.categories,
    audits,
  };
}

async function readJson(incoming) {
  let size = 0;
  const chunks = [];
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBrowserGateway(secret) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("Missing gateway secret");
  const routes = {
    "/content": [limiter(MAX_RENDERS), renderContent],
    "/lighthouse": [limiter(MAX_LIGHTHOUSE), runLighthouse],
  };
  return createServer(async (incoming, response) => {
    const supplied = Buffer.from(
      String(incoming.headers["x-browser-secret"] ?? ""),
    );
    const expected = Buffer.from(secret);
    const route = routes[incoming.url];
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      !route ||
      incoming.method !== "POST"
    ) {
      response.writeHead(404).end();
      return;
    }
    const [limit, handler] = route;
    const queuedAt = Date.now();
    let startedAt = queuedAt;
    let target = "";
    const log = (outcome) =>
      console.log(
        JSON.stringify({
          route: incoming.url,
          url: target,
          outcome,
          waitMs: startedAt - queuedAt,
          runMs: Date.now() - startedAt,
        }),
      );
    try {
      const request = await readJson(incoming);
      target = String(request?.url ?? "").slice(0, 300);
      const body = await limit(() => {
        startedAt = Date.now();
        return handler(request);
      });
      log("ok");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    } catch (error) {
      // Page text never goes back to the caller or the log, only the error.
      const message = error instanceof Error ? error.message : String(error);
      log(message.slice(0, 200));
      response.writeHead(error?.status ?? 502, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ success: false, error: message }));
    }
  });
}

const { CRAWL_GATEWAY_SECRET } = JSON.parse(
  await readFile("/config/secrets.json", "utf8"),
);
createEgressProxy().listen(PROXY_PORT, "127.0.0.1");
createBrowserGateway(CRAWL_GATEWAY_SECRET).listen(8091, "0.0.0.0");
