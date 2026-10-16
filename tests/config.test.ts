import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectConfig } from "../src/clash/config.js";
import { type Logger } from "../src/utils/log.js";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  close() {},
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const MINIMAL_RULES = `rule-providers: {}
custom_rules: []
ruleset_rules: []
`;

const MINIMAL_GROUPS = `main:
  - name: 主组
    type: select
`;

function setup(iniBody: string): ProjectConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  dirs.push(dir);

  const rulesFile = path.join(dir, "rules.yaml");
  fs.writeFileSync(rulesFile, MINIMAL_RULES);
  const groupsFile = path.join(dir, "groups.yaml");
  fs.writeFileSync(groupsFile, MINIMAL_GROUPS);

  const iniFile = path.join(dir, "config.ini");
  fs.writeFileSync(
    iniFile,
    `${iniBody}\n[files]\nrules_config = ${rulesFile}\ngroups_config = ${groupsFile}\n`,
  );
  return ProjectConfig.load(iniFile, silentLogger);
}

describe("ProjectConfig", () => {
  it("只返回 active_provider，名称转大写", () => {
    const cfg = setup(
      "[proxy_providers]\nAAA = https://a\nBBB = https://b\n[provider_control]\nactive_provider = bbb\n",
    );
    expect(cfg.getProxyProviders()).toEqual({ BBB: "https://b" });
    expect(cfg.providerNames).toEqual(["BBB"]);
    expect(cfg.proxyProvidersTotal).toBe(2);
  });

  it("active_provider 缺失时返回空", () => {
    const cfg = setup("[proxy_providers]\nAAA = https://a\n");
    expect(cfg.getProxyProviders()).toEqual({});
    expect(cfg.providerNames).toEqual([]);
  });

  it("解析地区、排除关键词与测速 URL", () => {
    const cfg = setup(
      "[regions]\n香港 = HK, 香港, HongKong\n\n[filter]\nexclude_keywords = 剩余, 官网\n",
    );
    expect(cfg.getRegions()).toEqual({ 香港: { keywords: ["HK", "香港", "HongKong"] } });
    expect(cfg.getExcludeKeywords()).toEqual(["剩余", "官网"]);
    expect(cfg.getTestUrl()).toContain("generate_204");
  });

  it("加载分组配置", () => {
    const cfg = setup("[regions]\n香港 = HK\n");
    expect(cfg.groups.main.map((group) => group.name)).toEqual(["主组"]);
  });
});
