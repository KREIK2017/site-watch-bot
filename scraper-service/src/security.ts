import { timingSafeEqual } from "node:crypto";

export function parseAllowedHosts(raw: string): string[] {
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean);
  if (!hosts.length || hosts.includes("*")) throw new Error("ALLOWED_HOSTS must contain explicit domains");
  return [...new Set(hosts)];
}

export function isAllowedHostname(hostname: string, allowedHosts: string[]): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => value === allowed || value.endsWith(`.${allowed}`));
}

export function validateTarget(rawUrl: string, allowedHosts: string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  if (url.username || url.password) throw new Error("Credentials in URLs are not supported");
  if (!isAllowedHostname(url.hostname, allowedHosts)) throw new Error(`Host is not allowed: ${url.hostname}`);
  return url;
}

export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
