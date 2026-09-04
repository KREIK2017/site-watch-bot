import { describe, expect, it } from "vitest";
import { parseMoney } from "./currency";

describe("parseMoney", () => {
  it("parses a space-thousands hryvnia amount (Steam-style formatting)", () => {
    expect(parseMoney("1 399₴")).toEqual({ amount: 1399, currency: "UAH" });
  });

  it("parses a currency-code-suffixed amount", () => {
    expect(parseMoney("36.32 BGN")).toEqual({ amount: 36.32, currency: "BGN" });
  });

  it("parses a symbol-prefixed amount", () => {
    expect(parseMoney("€49.99")).toEqual({ amount: 49.99, currency: "EUR" });
  });

  it("parses a plain hryvnia amount with decimals", () => {
    expect(parseMoney("900.00₴")).toEqual({ amount: 900, currency: "UAH" });
  });

  it("is agnostic to dot-vs-comma thousands separators", () => {
    // European-style "1.234,56 EUR" — dot as thousands, comma as decimal.
    expect(parseMoney("1.234,56 EUR")).toEqual({ amount: 1234.56, currency: "EUR" });
  });

  it("returns null when no currency can be identified (bare number)", () => {
    expect(parseMoney("501.50")).toBeNull();
  });

  it("returns null for text with no numbers at all", () => {
    expect(parseMoney("В наявності")).toBeNull();
  });
});
