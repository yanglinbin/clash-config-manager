import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

import { ClashConfigGenerator } from "../src/clash/generator.js";
import { createLogger } from "../src/utils/log.js";

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, "tests", "fixtures", "clash_profile.python.yaml");

describe("generator (provider 模式)", () => {
  it("生成的配置与 Python 参考实现语义一致", async () => {
    const generator = new ClashConfigGenerator(undefined, createLogger("test.log"));
    const config = await generator.generateConfig();

    expect(config).not.toBeNull();
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);

    const expected = parse(fs.readFileSync(FIXTURE, "utf-8"));
    expect(isDeepStrictEqual(config, expected)).toBe(true);
  });

  it("校验能发现悬空引用", async () => {
    const generator = new ClashConfigGenerator(undefined, createLogger("test.log"));
    const config = await generator.generateConfig();
    config!["proxy-groups"]![0]!.proxies = ["不存在的组"];
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain("不存在的组");
  });
});
