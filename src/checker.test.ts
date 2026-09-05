import { describe, expect, it } from "vitest";
import {
  detectHosting,
  detectPlatform,
  detectSecurityHeaders,
  extractPrice,
  extractStock,
  htmlToText,
  humanizeStatus,
  pickTitle,
} from "./checker";

describe("extractPrice", () => {
  it("finds a currency symbol glued to a number", () => {
    expect(extractPrice("Ціна: €49.99 знижка")).toBe("€49.99");
  });

  it("finds a currency symbol after the number (hryvnia)", () => {
    expect(extractPrice("900.00₴")).toBe("900.00₴");
  });

  it("finds a 3-letter currency code", () => {
    expect(extractPrice("36.32 BGN")).toBe("36.32 BGN");
  });

  it("falls back to a bare number (data-* attribute case)", () => {
    expect(extractPrice("501.50")).toBe("501.50");
  });

  it("returns null when there is nothing price-shaped", () => {
    expect(extractPrice("В наявності, доставка завтра")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractPrice("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(extractPrice("   \n\t  ")).toBeNull();
  });

  it("returns null for a currency symbol with no digits", () => {
    expect(extractPrice("Ціна: € — уточнюйте")).toBeNull();
  });

  it("does not treat an unrelated number (e.g. an order id) as a bare-number price", () => {
    // The bare-number fallback only fires when the *entire* trimmed input is
    // just a number — "Order #12345" has surrounding text, so it must not match.
    expect(extractPrice("Order #12345 confirmed")).toBeNull();
  });

  it("returns the first match when multiple prices appear in the text", () => {
    expect(extractPrice("було 100€, стало 80€")).toBe("100€");
  });
});

describe("extractStock", () => {
  it("recognizes an out-of-stock phrase", () => {
    expect(extractStock("Наразі товар Out of stock, повернеться пізніше")).toBe("Немає в наявності");
  });

  it("recognizes an in-stock phrase", () => {
    expect(extractStock("Add to cart — доставка 1-2 дні")).toBe("В наявності");
  });

  it("prefers out-of-stock when both an in-stock and out-of-stock phrase appear", () => {
    // Regression guard: extractStock checks OUT_OF_STOCK_PATTERNS first.
    expect(extractStock("Add to cart — Out of stock")).toBe("Немає в наявності");
  });

  it("returns null when neither phrase is present", () => {
    expect(extractStock("Ласкаво просимо до нашого магазину")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractStock("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractStock("OUT OF STOCK — CHECK BACK LATER")).toBe("Немає в наявності");
  });

  it("recognizes a Ukrainian out-of-stock phrase", () => {
    expect(extractStock("На жаль, немає в наявності")).toBe("Немає в наявності");
  });

  it("KNOWN LIMITATION: plain substring matching can false-positive on an unrelated phrase", () => {
    // extractStock uses lower.includes(pattern), not word-boundary matching.
    // "walking in stockings" contains the literal substring "in stock". This
    // test pins the current (accepted, low real-world risk) behavior so a
    // future refactor changes it on purpose, not by accident.
    expect(extractStock("Ідеально для прогулянок: walking in stockings")).toBe("В наявності");
  });
});

describe("humanizeStatus", () => {
  it("labels 2xx as online", () => {
    expect(humanizeStatus(200)).toContain("Онлайн");
  });

  it("labels 404 specifically", () => {
    expect(humanizeStatus(404)).toContain("404");
  });

  it("labels 403 specifically", () => {
    expect(humanizeStatus(403)).toContain("403");
  });

  it("labels other 4xx generically", () => {
    expect(humanizeStatus(418)).toContain("418");
  });

  it("labels 5xx as server down", () => {
    expect(humanizeStatus(500)).toContain("500");
  });

  it("labels null as unreachable", () => {
    expect(humanizeStatus(null)).toContain("Недоступний");
  });

  it("falls back to a bare label for an out-of-range status (e.g. 0)", () => {
    // Not null, not in any known HTTP range — a fetch() implementation could
    // in principle hand back something unusual; must not throw either way.
    expect(humanizeStatus(0)).toBe("Статус 0");
  });

  it("falls back to a bare label for a negative status", () => {
    expect(humanizeStatus(-1)).toBe("Статус -1");
  });

  it("treats the 199/200 boundary correctly", () => {
    expect(humanizeStatus(199)).not.toContain("Онлайн");
    expect(humanizeStatus(200)).toContain("Онлайн");
  });

  it("treats the 299/300 boundary correctly", () => {
    expect(humanizeStatus(299)).toContain("Онлайн");
    expect(humanizeStatus(300)).not.toContain("Онлайн");
  });
});

describe("htmlToText", () => {
  it("strips script and style content, keeps visible text", () => {
    const html = "<html><head><style>.a{color:red}</style></head><body><script>evil()</script><p>Hello world</p></body></html>";
    expect(htmlToText(html)).toBe("Hello world");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToText("<p>Fish &amp; Chips &mdash; &quot;great&quot;</p>")).toContain("Fish & Chips");
  });

  it("collapses whitespace", () => {
    expect(htmlToText("<p>a</p>\n\n   <p>b</p>")).toBe("a b");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("returns an empty string for markup with no text at all", () => {
    expect(htmlToText("<div><span></span><br/></div>")).toBe("");
  });

  it("does not throw on an unclosed tag", () => {
    expect(htmlToText("<p>unclosed paragraph")).toBe("unclosed paragraph");
  });

  it("does not throw on a stray closing tag with no opener", () => {
    expect(htmlToText("orphan</div> text")).toBe("orphan text");
  });
});

describe("pickTitle", () => {
  it("prefers the longer, more descriptive title (Amazon og:title bug)", () => {
    const generic = "Amazon";
    const specific = "Amazon.com: STGAubron Gaming PC Desktop, Core I5, RX 560 4G";
    expect(pickTitle(generic, specific)).toBe(specific);
  });

  it("returns the other value when one side is null", () => {
    expect(pickTitle(null, "Only title")).toBe("Only title");
    expect(pickTitle("Only title", null)).toBe("Only title");
  });

  it("returns null when both are null", () => {
    expect(pickTitle(null, null)).toBeNull();
  });

  it("KNOWN LIMITATION: treats an empty string the same as null (falsy check, not null check)", () => {
    expect(pickTitle("", "Real Title")).toBe("Real Title");
  });

  it("keeps the first argument on an exact length tie", () => {
    expect(pickTitle("aaaa", "bbbb")).toBe("aaaa");
  });
});

describe("detectPlatform", () => {
  it("recognizes WordPress from an asset path signature", () => {
    expect(detectPlatform('<link rel="stylesheet" href="/wp-content/themes/x/style.css">')).toBe("WordPress");
  });

  it("recognizes a platform from the generator meta tag", () => {
    expect(detectPlatform('<meta name="generator" content="WordPress 6.4">')).toBe("WordPress");
  });

  it("returns null for a plain page with no known signature", () => {
    expect(detectPlatform("<html><body><h1>Hello</h1></body></html>")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectPlatform("")).toBeNull();
  });
});

describe("detectHosting", () => {
  it("recognizes Cloudflare from the Server header", () => {
    expect(detectHosting(new Headers({ server: "cloudflare" }))).toBe("Cloudflare");
  });

  it("recognizes Vercel from its id header even without a Server header", () => {
    expect(detectHosting(new Headers({ "x-vercel-id": "abc123" }))).toBe("Vercel");
  });

  it("recognizes nginx", () => {
    expect(detectHosting(new Headers({ server: "nginx/1.24.0" }))).toBe("nginx");
  });

  it("returns null when there is no recognizable Server header", () => {
    expect(detectHosting(new Headers())).toBeNull();
  });

  it("returns null for an unrecognized Server header value", () => {
    expect(detectHosting(new Headers({ server: "MyCustomServer/1.0" }))).toBeNull();
  });
});

describe("detectSecurityHeaders", () => {
  it("lists every recognized security header present", () => {
    const headers = new Headers({
      "strict-transport-security": "max-age=63072000",
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
    });
    expect(detectSecurityHeaders(headers)).toBe("HSTS, CSP, X-Frame-Options");
  });

  it("lists only the headers actually present", () => {
    expect(detectSecurityHeaders(new Headers({ "x-frame-options": "SAMEORIGIN" }))).toBe("X-Frame-Options");
  });

  it("returns null when none of the recognized headers are present", () => {
    expect(detectSecurityHeaders(new Headers({ "content-type": "text/html" }))).toBeNull();
  });
});
