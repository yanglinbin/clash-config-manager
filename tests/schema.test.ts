import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadRulesConfig } from "../src/clash/config.js";

describe("rules.yaml schema 校验", () => {
  it("当前 rules.yaml 通过 schema", () => {
    const rules = loadRulesConfig(path.join(process.cwd(), "config", "rules.yaml"));
    expect(rules).toHaveProperty("custom_rules");
    expect(Array.isArray(rules.custom_rules)).toBe(true);
    expect(rules).not.toHaveProperty("proxy_groups");
  });

  it("schema 违规时抛出 ConfigError", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-"));
    const file = path.join(dir, "rules.yaml");
    try {
      fs.writeFileSync(file, "custom_rules:\n  - 'NOT-A-RULE,x'\n");
      expect(() => loadRulesConfig(file)).toThrow(ConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
