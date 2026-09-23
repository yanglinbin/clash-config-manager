import path from "node:path";

import { describe, expect, it } from "vitest";

import { lint } from "../src/cli/lint.js";

describe("lint_rules", () => {
  it("当前 rules.yaml 无错误、10 个警告", () => {
    const target = path.join(process.cwd(), "config", "rules.yaml");
    const { errors, warnings } = lint(target);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(10);
  });
});
