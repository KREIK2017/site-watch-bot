import { describe, expect, it } from "vitest";
import { extractPrice, extractStock, htmlToText, humanizeStatus, pickTitle } from "./checker";

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
});
