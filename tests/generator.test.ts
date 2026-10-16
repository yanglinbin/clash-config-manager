import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

import { ClashConfigGenerator } from "../src/clash/generator.js";
import { createLogger } from "../src/utils/log.js";

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, "tests", "fixtures", "clash_profile.python.yaml");
// 测试专用配置（无密钥）；订阅链接模式不会去拉取订阅
const CONFIG_FIXTURE = path.join(ROOT, "tests", "fixtures", "config.ini");

describe("generator (订阅链接模式)", () => {
  it("生成的配置与参考实现（黄金文件）语义一致", async () => {
    const generator = new ClashConfigGenerator(CONFIG_FIXTURE, createLogger("test.log"));
    const config = await generator.generateConfig();

    expect(config).not.toBeNull();
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);

    const expected = parse(fs.readFileSync(FIXTURE, "utf-8"));
    expect(isDeepStrictEqual(config, expected)).toBe(true);
  });

  it("校验能发现悬空引用", async () => {
    const generator = new ClashConfigGenerator(CONFIG_FIXTURE, createLogger("test.log"));
    const config = await generator.generateConfig();
    config!["proxy-groups"]![0]!.proxies = ["不存在的组"];
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain("不存在的组");
  });

  it("校验能发现未定义的 rule-provider", async () => {
    const generator = new ClashConfigGenerator(CONFIG_FIXTURE, createLogger("test.log"));
    const config = await generator.generateConfig();
    config!.rules.push("RULE-SET,not-defined,海外代理");
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain("not-defined");
  });

  it("校验能发现无效 CIDR", async () => {
    const generator = new ClashConfigGenerator(CONFIG_FIXTURE, createLogger("test.log"));
    const config = await generator.generateConfig();
    config!.rules.push("IP-CIDR,999.1.1.0/24,全球直连");
    const { ok, errors } = generator.validateGeneratedConfig(config!);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain("999.1.1.0/24");
  });

  it("无效的默认节点被忽略，而不是导致生成失败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-"));
    const ini = path.join(dir, "config.ini");
    try {
      const base = fs.readFileSync(CONFIG_FIXTURE, "utf-8");
      fs.writeFileSync(ini, `${base}\n海外代理 = 不存在的组\n`);
      const generator = new ClashConfigGenerator(ini, createLogger("test.log"));
      const config = await generator.generateConfig();
      const { ok, errors } = generator.validateGeneratedConfig(config!);
      expect(ok).toBe(true);
      expect(errors).toEqual([]);
      const main = config!["proxy-groups"]!.find((group) => group.name === "海外代理");
      expect(main?.proxies ?? []).not.toContain("不存在的组");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
