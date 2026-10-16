import path from "node:path";

import { describe, expect, it } from "vitest";

import { lint } from "../src/cli/lint.js";

describe("lint_rules", () => {
  it("当前 rules.yaml 无错误（含 CIDR 重叠告警）", () => {
    const target = path.join(process.cwd(), "config", "rules.yaml");
    const { errors, warnings } = lint(target);
    expect(errors).toEqual([]);
    expect(warnings.some((warning) => warning.includes("CIDR 部分重叠"))).toBe(true);
  });
});
