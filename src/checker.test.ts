import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeUrl,
  detectChallenge,
  detectHosting,
  detectPlatform,
  detectSecurityHeaders,
  extractPrice,
  extractRozetkaData,
  extractStructuredData,
  extractStock,
  htmlToText,
  pickTitle,
} from "./checker";
import type { Env } from "./types";

afterEach(() => vi.restoreAllMocks());

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

describe("extractStructuredData seller", () => {
  it("extracts the seller from a Schema.org Offer", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Example product",
      offers: {
        "@type": "Offer",
        price: "26.99",
        priceCurrency: "PLN",
        seller: { "@type": "Organization", name: "Oasis_trade" },
      },
    })}</script>`;

    expect(extractStructuredData(html).seller).toBe("Oasis_trade");
  });

  it("falls back to Allegro's stable seller-profile URL", () => {
    const html = '<a href="https://allegro.pl/uzytkownik/Oasis_trade/oceny">Sprzedawca</a>';
    expect(extractStructuredData(html).seller).toBe("Oasis_trade");
  });

  it("reads an escaped Allegro seller-profile URL from application JSON", () => {
    const html = String.raw`{"sellerUrl":"https:\/\/business.allegro.pl\/uzytkownik\/Oasis_trade"}`;
    expect(extractStructuredData(html).seller).toBe("Oasis_trade");
  });

  it("reads Allegro's sellerLogin application field", () => {
    expect(extractStructuredData('{"sellerLogin":"Oasis_trade"}').seller).toBe("Oasis_trade");
  });

  it("falls back to the rendered Polish seller label", () => {
    expect(extractStructuredData("<div>Sprzedaje firma Oasis_trade</div>").seller).toBe("Oasis_trade");
  });
});

describe("extractStock", () => {
  // extractStock returns a language-agnostic internal code (see i18n.ts's
  // localizeStock), not display text — the stored value must not depend on
  // whatever language happened to be active at check time.
  it("recognizes an out-of-stock phrase", () => {
    expect(extractStock("Наразі товар Out of stock, повернеться пізніше")).toBe("out_of_stock");
  });

  it("recognizes an in-stock phrase", () => {
    expect(extractStock("Add to cart — доставка 1-2 дні")).toBe("in_stock");
  });

  it("prefers out-of-stock when both an in-stock and out-of-stock phrase appear", () => {
    // Regression guard: extractStock checks OUT_OF_STOCK_PATTERNS first.
    expect(extractStock("Add to cart — Out of stock")).toBe("out_of_stock");
  });

  it("returns null when neither phrase is present", () => {
    expect(extractStock("Ласкаво просимо до нашого магазину")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractStock("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractStock("OUT OF STOCK — CHECK BACK LATER")).toBe("out_of_stock");
  });

  it("recognizes a Ukrainian out-of-stock phrase", () => {
    expect(extractStock("На жаль, немає в наявності")).toBe("out_of_stock");
  });

  it("recognizes a limited-stock phrase", () => {
    expect(extractStock("Закінчується")).toBe("limited");
  });

  it("KNOWN LIMITATION: plain substring matching can false-positive on an unrelated phrase", () => {
    // extractStock uses lower.includes(pattern), not word-boundary matching.
    // "walking in stockings" contains the literal substring "in stock". This
    // test pins the current (accepted, low real-world risk) behavior so a
    // future refactor changes it on purpose, not by accident.
    expect(extractStock("Ідеально для прогулянок: walking in stockings")).toBe("in_stock");
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

describe("detectChallenge", () => {
  it("detects Cloudflare's challenge header even with HTTP 200", () => {
    expect(detectChallenge(200, new Headers({ "cf-mitigated": "challenge" }), "<html></html>"))
      .toBe("Cloudflare challenge");
  });

  it("detects a JavaScript challenge page that returns HTTP 200", () => {
    const html = '<html><head><title>Just a moment...</title></head><script src="/cdn-cgi/challenge-platform/x"></script></html>';
    expect(detectChallenge(200, new Headers(), html)).toBe("anti-bot challenge");
  });

  it("classifies rate limiting as a fallback reason", () => {
    expect(detectChallenge(429, new Headers(), "Too many requests")).toBe("rate limited");
  });

  it("does not flag a normal successful page", () => {
    expect(detectChallenge(200, new Headers(), "<html><title>Product</title><p>In stock</p></html>"))
      .toBeNull();
  });

  it("returns an access error without replacing the site's real status or data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><title>Just a moment...</title></html>", {
          status: 200,
          headers: { "cf-mitigated": "challenge" },
        })
      )
    );
    const env = {} as Env;

    const result = await analyzeUrl(env, "https://protected.example/product");

    expect(result.status).toBeNull();
    expect(result.error).toContain("захист від автоматизованих запитів");
    expect(result.price).toBeNull();
    expect(result.textHash).toBeNull();
  });

  it("retries a challenged direct response through Browser Run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><title>Just a moment...</title></html>", {
          status: 200,
          headers: { "cf-mitigated": "challenge" },
        })
      )
    );
    const quickAction = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result:
            '<html><head><title>Rendered product</title></head><body><script type="application/ld+json">{"@type":"Product","name":"Rendered product","offers":{"price":"499","priceCurrency":"UAH","availability":"https://schema.org/InStock"}}</script></body></html>',
          meta: { status: 200, title: "Rendered product", headers: { "content-type": "text/html" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const env = { BROWSER: { quickAction } } as unknown as Env;

    const result = await analyzeUrl(env, "https://shop.example/product");

    expect(quickAction).toHaveBeenCalledOnce();
    expect(result.error).toBeUndefined();
    expect(result.title).toBe("Rendered product");
    expect(result.price).toBe("499 UAH");
    expect(result.stock).toBe("in_stock");
  });

  it("does not spend browser time on an ordinary successful page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><title>News</title><body>A normal page with enough visible content to monitor without rendering. This sentence makes the page intentionally longer than a tiny application shell, and so does this one.</body></html>"))
    );
    const quickAction = vi.fn();
    const env = { BROWSER: { quickAction } } as unknown as Env;

    const result = await analyzeUrl(env, "https://example.com/news");

    expect(quickAction).not.toHaveBeenCalled();
    expect(result.title).toBe("News");
  });

  it("uses the authenticated VPS browser after Cloudflare Browser Run is blocked", async () => {
    const productHtml =
      '<html><head><title>Allegro product</title></head><body><script type="application/ld+json">{"@type":"Product","name":"Allegro product","offers":{"price":"79.99","priceCurrency":"PLN","availability":"https://schema.org/InStock"}}</script></body></html>';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><title>Just a moment...</title></html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            headers: { "content-type": "text/html" },
            html: productHtml,
            responseMs: 1234,
            blocked: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const quickAction = vi.fn(async () => new Response("blocked", { status: 503 }));
    const env = {
      BROWSER: { quickAction },
      SCRAPER_SERVICE_URL: "https://scraper.example.com",
      SCRAPER_SERVICE_TOKEN: "shared-secret",
    } as unknown as Env;

    const result = await analyzeUrl(env, "https://business.allegro.pl/oferta/example");

    expect(result.error).toBeUndefined();
    expect(result.title).toBe("Allegro product");
    expect(result.price).toBe("79.99 PLN");
    expect(result.stock).toBe("in_stock");
    expect(result.responseMs).toBe(1234);
    const [serviceUrl, serviceInit] = fetchMock.mock.calls[1];
    expect(serviceUrl).toBe("https://scraper.example.com/fetch");
    expect((serviceInit as RequestInit).headers).toMatchObject({ authorization: "Bearer shared-secret" });
    expect(JSON.parse((serviceInit as RequestInit).body as string)).toEqual({
      url: "https://business.allegro.pl/oferta/example",
    });
  });

  it("does not trust a challenge page returned by the VPS browser", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><title>Just a moment...</title></html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            html: "<html><title>Just a moment...</title></html>",
            blocked: true,
            blockReason: "anti-bot challenge",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const quickAction = vi.fn(async () => new Response("blocked", { status: 503 }));
    const env = {
      BROWSER: { quickAction },
      SCRAPER_SERVICE_URL: "https://scraper.example.com",
      SCRAPER_SERVICE_TOKEN: "shared-secret",
    } as unknown as Env;

    const result = await analyzeUrl(env, "https://business.allegro.pl/oferta/example");

    expect(result.status).toBeNull();
    expect(result.title).toBeNull();
    expect(result.error).toContain("захист від автоматизованих запитів");
  });

  it("uses the Rozetka Reader fallback when both direct fetch and Browser Run are blocked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><title>Just a moment...</title></html>", {
          status: 200,
          headers: { "cf-mitigated": "challenge" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              title: "Test Rozetka product",
              content: "# Test Rozetka product\n\nЗакінчується\n\nКод : 626147231\n\n999₴\n\n849₴\n\nКупити\n\nДоставка 49₴",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const quickAction = vi.fn(async () => new Response("blocked", { status: 503 }));
    const env = { BROWSER: { quickAction } } as unknown as Env;

    const result = await analyzeUrl(env, "https://rozetka.com.ua/ua/example/p626147231/");

    expect(quickAction).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.title).toBe("Test Rozetka product");
    expect(result.price).toBe("849₴");
    expect(result.priceTrusted).toBe(true);
    expect(result.stock).toBe("limited");
    expect(result.error).toBeUndefined();
  });

  it("rejects a challenge page returned by the Reader itself", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><title>Just a moment...</title></html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              title: "Just a moment...",
              content: "Please verify you are human /cdn-cgi/challenge-platform/",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const quickAction = vi.fn(async () => new Response("blocked", { status: 503 }));
    const env = { BROWSER: { quickAction } } as unknown as Env;

    const result = await analyzeUrl(env, "https://rozetka.com.ua/ua/example/p626147231/");

    expect(result.title).toBeNull();
    expect(result.status).toBeNull();
    expect(result.error).toContain("захист від автоматизованих запитів");
  });
});

describe("extractRozetkaData", () => {
  it("selects the discounted price and ignores later delivery prices", () => {
    const text = "Код : 626147231 999₴ 849₴ Купити Доставка 49₴";
    expect(extractRozetkaData(text)).toEqual({ price: "849₴", stock: null });
  });
});
