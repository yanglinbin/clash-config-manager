import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { loadGroupConfig } from "../src/clash/groups.js";
import { migrate } from "../src/cli/migrateGroups.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const LEGACY_INI = `[merged_regions]
default_type = url-test
香港 = select

[main_proxy_region_groups]
全球直连 = manual
AI平台 = 香港,日本

[custom_groups]
AI专用 = fallback, XXAI, 香港|日本, AI平台

[relay_groups]
name = 统一代理
type = fallback

[proxy_group_defaults]
海外代理 = 香港
`;

const LEGACY_RULES = `proxy_groups:
  main_groups:
    - name: 海外代理
      type: select
    - name: 全球直连
      type: select
    - name: AI平台
      type: select
  special_groups:
    - name: 广告拦截
      type: select
      proxies: [REJECT, DIRECT]
`;

function setup(): { iniPath: string; rulesPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  dirs.push(dir);
  const iniPath = path.join(dir, "config.ini");
  const rulesPath = path.join(dir, "rules.yaml");
  fs.writeFileSync(iniPath, LEGACY_INI);
  fs.writeFileSync(rulesPath, LEGACY_RULES);
  return { iniPath, rulesPath, dir };
}

describe("migrateGroups", () => {
  it("把旧分组配置迁移为 groups.yaml", () => {
    const { iniPath, rulesPath, dir } = setup();
    const { yaml, warnings } = migrate(iniPath, rulesPath);

    const doc = parse(yaml) as {
      version: number;
      region_groups: { type: string; overrides: Record<string, string> };
      custom: Array<{ name: string; type: string; regions: string[]; targets: string[] }>;
      main: Array<{ name: string; regions?: unknown; default?: string; proxies?: string[] }>;
    };
    expect(doc.version).toBe(1);
    expect(doc.region_groups.type).toBe("url-test");
    expect(doc.region_groups.overrides).toEqual({ 香港: "select" });
    expect(doc.custom[0]).toMatchObject({
      name: "AI专用",
      type: "fallback",
      regions: ["香港", "日本"],
      targets: ["AI平台"],
    });

    const mainByName = Object.fromEntries(doc.main.map((group) => [group.name, group]));
    expect(mainByName["海外代理"].default).toBe("香港");
    expect(mainByName["全球直连"].regions).toBe("none");
    expect(mainByName["AI平台"].regions).toEqual(["香港", "日本"]);

    const adBlock = doc.main.find((group) => group.name === "广告拦截");
    expect(adBlock?.proxies).toEqual(["REJECT", "DIRECT"]);

    expect(warnings.some((w) => w.includes("relay_groups"))).toBe(true);

    // 迁移产物必须能通过新模型的校验
    const out = path.join(dir, "groups.yaml");
    fs.writeFileSync(out, yaml);
    const cfg = loadGroupConfig(out, new Set(["香港", "日本"]));
    expect(cfg.main.map((g) => g.name)).toEqual(["海外代理", "全球直连", "AI平台", "广告拦截"]);
  });
});
