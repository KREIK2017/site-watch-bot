import { describe, expect, it } from "vitest";
import { deriveMonitorState, isBlockedError } from "./monitoring-state";

describe("deriveMonitorState", () => {
  it("keeps an anti-bot challenge separate from an offline website", () => {
    expect(deriveMonitorState({ status: null, error: "Site showed an anti-bot challenge" })).toBe("BLOCKED");
  });

  it("maps successful, redirect and failed HTTP responses", () => {
    expect(deriveMonitorState({ status: 200 })).toBe("ONLINE");
    expect(deriveMonitorState({ status: 302 })).toBe("DEGRADED");
    expect(deriveMonitorState({ status: 503 })).toBe("OFFLINE");
  });

  it("uses UNKNOWN for a network failure and PAUSED when requested", () => {
    expect(deriveMonitorState({ status: null, error: "network timeout" })).toBe("UNKNOWN");
    expect(deriveMonitorState({ status: 200 }, true)).toBe("PAUSED");
  });
});

describe("isBlockedError", () => {
  it("recognizes localized access restriction messages", () => {
    expect(isBlockedError("Сайт показав захист від автоматизованих запитів")).toBe(true);
    expect(isBlockedError("Сайт ограничил автоматический доступ")).toBe(true);
  });
});
