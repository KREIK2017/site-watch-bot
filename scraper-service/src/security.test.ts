import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedHostname, parseAllowedHosts, tokenMatches, validateTarget } from "./security.js";

const hosts = parseAllowedHosts("rozetka.com.ua, allegro.pl");

test("allows configured domains and their subdomains", () => {
  assert.equal(isAllowedHostname("rozetka.com.ua", hosts), true);
  assert.equal(isAllowedHostname("business.allegro.pl", hosts), true);
});

test("does not allow suffix tricks or arbitrary hosts", () => {
  assert.equal(isAllowedHostname("rozetka.com.ua.example.org", hosts), false);
  assert.throws(() => validateTarget("http://127.0.0.1/admin", hosts), /not allowed/);
});

test("rejects non-http URLs and credentials", () => {
  assert.throws(() => validateTarget("file:///etc/passwd", hosts), /HTTP/);
  assert.throws(() => validateTarget("https://user:pass@rozetka.com.ua/", hosts), /Credentials/);
});

test("compares bearer tokens", () => {
  assert.equal(tokenMatches("Bearer a-secret", "a-secret"), true);
  assert.equal(tokenMatches("Bearer wrong", "a-secret"), false);
  assert.equal(tokenMatches(undefined, "a-secret"), false);
});
