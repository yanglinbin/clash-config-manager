import { describe, expect, it } from "vitest";

import { getBool, getInt, getStr, hasSection, parseIni } from "../src/utils/ini.js";

const SAMPLE = [
  "# 注释",
  "; 另一种注释",
  "[server]",
  "port = 8080",
  "name: clash",
  "empty =",
  "",
  "[Flag]",
  "enabled = yes",
].join("\n");

describe("parseIni / 取值助手", () => {
  it("解析节、键值、两种分隔符与注释", () => {
    const ini = parseIni(SAMPLE);
    expect(hasSection(ini, "server")).toBe(true);
    expect(hasSection(ini, "missing")).toBe(false);
    expect(getStr(ini, "server", "port")).toBe("8080");
    expect(getStr(ini, "server", "name")).toBe("clash");
    expect(getStr(ini, "server", "empty")).toBe("");
    expect(getStr(ini, "server", "absent", "fallback")).toBe("fallback");
    // 键名大小写敏感（对齐 configparser optionxform=str）
    expect(getStr(ini, "Flag", "enabled")).toBe("yes");
  });

  it("getInt 合法返回数字，非法抛错", () => {
    const ini = parseIni(SAMPLE);
    expect(getInt(ini, "server", "port", 1)).toBe(8080);
    expect(getInt(ini, "server", "absent", 42)).toBe(42);
    expect(() => getInt(parseIni("[a]\nx = abc"), "a", "x", 0)).toThrow();
  });

  it("getBool 识别真值/假值，非法抛错", () => {
    const ini = parseIni("[a]\nt = true\nf = off\nx = maybe");
    expect(getBool(ini, "a", "t", false)).toBe(true);
    expect(getBool(ini, "a", "f", true)).toBe(false);
    expect(getBool(ini, "a", "absent", true)).toBe(true);
    expect(() => getBool(ini, "a", "x", false)).toThrow();
  });
});
