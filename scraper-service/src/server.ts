import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContextOptions } from "playwright";
import { isAllowedHostname, parseAllowedHosts, tokenMatches, validateTarget } from "./security.js";

const port = Number(process.env.PORT ?? 3000);
const apiToken = process.env.API_TOKEN?.trim();
if (!apiToken) throw new Error("API_TOKEN is required");

const allowedHosts = parseAllowedHosts(process.env.ALLOWED_HOSTS ?? "rozetka.com.ua,allegro.pl");
const dataDir = process.env.DATA_DIR ?? "/data/sessions";
const navigationTimeoutMs = Number(process.env.NAVIGATION_TIMEOUT_MS ?? 30000);
const settleMs = Number(process.env.SETTLE_MS ?? 1500);
const maxHtmlBytes = Number(process.env.MAX_HTML_BYTES ?? 5_000_000);
const maxBodyBytes = 32_000;

const proxy = process.env.PROXY_SERVER
  ? {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    }
  : undefined;

let browser: Browser;
const hostQueues = new Map<string, Promise<void>>();

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function challengeReason(status: number, html: string, headers: Record<string, string>): string | null {
  if (headers["cf-mitigated"]?.toLowerCase() === "challenge") return "Cloudflare challenge";
  const sample = html.slice(0, 120_000).toLowerCase();
  if (
    sample.includes("/cdn-cgi/challenge-platform/") ||
    sample.includes("cf_chl_opt") ||
    /<title[^>]*>\s*(just a moment|attention required|access denied)/i.test(sample) ||
    sample.includes("verify you are human") ||
    sample.includes("please enable js and disable any ad blocker")
  ) return "anti-bot challenge";
  if (status === 429) return "rate limited";
  if (status === 403) return "access forbidden";
  return null;
}

function profileFor(hostname: string): Pick<BrowserContextOptions, "locale" | "timezoneId" | "viewport" | "colorScheme"> {
  if (hostname.endsWith("allegro.pl")) {
    return { locale: "pl-PL", timezoneId: "Europe/Warsaw", viewport: { width: 1440, height: 900 }, colorScheme: "light" };
  }
  return { locale: "uk-UA", timezoneId: "Europe/Kyiv", viewport: { width: 1440, height: 900 }, colorScheme: "light" };
}

async function withHostQueue<T>(hostname: string, operation: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(hostname) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  hostQueues.set(hostname, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (hostQueues.get(hostname) === tail) hostQueues.delete(hostname);
  }
}

async function fetchPage(target: URL, selector?: string): Promise<Record<string, unknown>> {
  return withHostQueue(target.hostname, async () => {
    const sessionName = createHash("sha256").update(target.hostname).digest("hex");
    const storagePath = path.join(dataDir, `${sessionName}.json`);
    const options: BrowserContextOptions = { ...profileFor(target.hostname) };
    try {
      options.storageState = storagePath;
      const context = await browser.newContext(options);
      return await browseInContext(context, target, selector, storagePath);
    } catch (error) {
      // A corrupt or first-run state file should not break the service.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const context = await browser.newContext(profileFor(target.hostname));
      return browseInContext(context, target, selector, storagePath);
    }
  });
}

async function browseInContext(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  target: URL,
  selector: string | undefined,
  storagePath: string
): Promise<Record<string, unknown>> {
  const page = await context.newPage();
  const startedAt = Date.now();
  try {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const next = new URL(request.url());
        if (!isAllowedHostname(next.hostname, allowedHosts)) return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const navigation = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    if (!navigation) throw new Error("Navigation returned no HTTP response");
    await page.waitForTimeout(settleMs);
    if (selector && !selector.startsWith("auto:")) {
      await page.locator(selector).first().waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
    }

    const finalUrl = new URL(page.url());
    if (!isAllowedHostname(finalUrl.hostname, allowedHosts)) throw new Error("Navigation left the allowed domain");
    const html = await page.content();
    if (Buffer.byteLength(html) > maxHtmlBytes) throw new Error("Rendered HTML exceeds MAX_HTML_BYTES");
    const headers = await navigation.allHeaders();
    const status = navigation.status();
    const blockReason = challengeReason(status, html, headers);
    await mkdir(path.dirname(storagePath), { recursive: true });
    await context.storageState({ path: storagePath });
    return {
      ok: true,
      status,
      headers,
      html,
      title: await page.title(),
      finalUrl: finalUrl.toString(),
      responseMs: Date.now() - startedAt,
      blocked: Boolean(blockReason),
      blockReason,
    };
  } finally {
    await context.close();
  }
}

await mkdir(dataDir, { recursive: true });
browser = await chromium.launch({ headless: true, proxy });

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: true });
    }
    if (request.method !== "POST" || request.url !== "/fetch") {
      return json(response, 404, { ok: false, error: "Not found" });
    }
    if (!tokenMatches(request.headers.authorization, apiToken)) {
      return json(response, 401, { ok: false, error: "Unauthorized" });
    }
    const body = await readJson(request) as { url?: unknown; selector?: unknown };
    if (typeof body.url !== "string") return json(response, 400, { ok: false, error: "url is required" });
    if (body.selector !== undefined && typeof body.selector !== "string") {
      return json(response, 400, { ok: false, error: "selector must be a string" });
    }
    const target = validateTarget(body.url, allowedHosts);
    const result = await fetchPage(target, body.selector);
    return json(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const clientError = /required|supported|allowed|Credentials|too large|JSON/i.test(message);
    console.error("Request failed", message);
    return json(response, clientError ? 400 : 502, { ok: false, error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Scraper service listening on :${port}; allowed hosts: ${allowedHosts.join(", ")}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await browser.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
