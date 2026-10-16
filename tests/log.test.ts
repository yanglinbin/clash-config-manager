import { describe, expect, it } from "vitest";

import { closeAllLoggers, createLogger } from "../src/utils/log.js";

describe("logger", () => {
  it("同名日志器返回同一实例（避免重复打开文件流）", () => {
    const first = createLogger("test.log");
    const second = createLogger("test.log");
    expect(first).toBe(second);
    closeAllLoggers();
  });
});
