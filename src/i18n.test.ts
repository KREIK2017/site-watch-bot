import { describe, expect, it } from "vitest";
import { humanizeStatus, isLang, localizeStock, t } from "./i18n";

describe("humanizeStatus", () => {
  it("labels 2xx as online, per language", () => {
    expect(humanizeStatus(200, "uk")).toContain("Онлайн");
    expect(humanizeStatus(200, "ru")).toContain("Онлайн");
    expect(humanizeStatus(200, "en")).toContain("Online");
  });

  it("labels 404 specifically", () => {
    expect(humanizeStatus(404, "en")).toContain("404");
  });

  it("labels 403 specifically", () => {
    expect(humanizeStatus(403, "en")).toContain("403");
  });

  it("labels other 4xx generically", () => {
    expect(humanizeStatus(418, "en")).toContain("418");
  });

  it("labels 5xx as server down", () => {
    expect(humanizeStatus(500, "en")).toContain("500");
  });

  it("labels null as unreachable", () => {
    expect(humanizeStatus(null, "en")).toContain("Unreachable");
  });

  it("falls back to a bare label for an out-of-range status (e.g. 0)", () => {
    // Not null, not in any known HTTP range — a fetch() implementation could
    // in principle hand back something unusual; must not throw either way.
    expect(humanizeStatus(0, "en")).toBe("Status 0");
  });

  it("falls back to a bare label for a negative status", () => {
    expect(humanizeStatus(-1, "en")).toBe("Status -1");
  });

  it("treats the 199/200 boundary correctly", () => {
    expect(humanizeStatus(199, "en")).not.toContain("Online");
    expect(humanizeStatus(200, "en")).toContain("Online");
  });

  it("treats the 299/300 boundary correctly", () => {
    expect(humanizeStatus(299, "en")).toContain("Online");
    expect(humanizeStatus(300, "en")).not.toContain("Online");
  });
});

describe("localizeStock", () => {
  it("localizes the in-stock code per language", () => {
    expect(localizeStock("in_stock", "uk")).toBe("В наявності");
    expect(localizeStock("in_stock", "ru")).toBe("В наличии");
    expect(localizeStock("in_stock", "en")).toBe("In stock");
  });

  it("localizes the out-of-stock code", () => {
    expect(localizeStock("out_of_stock", "en")).toBe("Out of stock");
  });

  it("returns null for null input", () => {
    expect(localizeStock(null, "en")).toBeNull();
  });

  it("passes through an unrecognized code unchanged (defensive fallback)", () => {
    expect(localizeStock("some_future_code", "en")).toBe("some_future_code");
  });
});

describe("isLang", () => {
  it("accepts every supported language", () => {
    expect(isLang("uk")).toBe(true);
    expect(isLang("ru")).toBe(true);
    expect(isLang("en")).toBe(true);
  });

  it("rejects an unsupported value", () => {
    expect(isLang("fr")).toBe(false);
    expect(isLang("")).toBe(false);
  });
});

describe("t", () => {
  it("substitutes a placeholder", () => {
    expect(t("en", "alreadyWatching", { id: 42 })).toBe("Already watching this site (id 42).");
  });

  it("leaves an unmatched placeholder untouched rather than throwing", () => {
    expect(t("en", "watchUsage")).not.toContain("undefined");
  });
});
