#!/usr/bin/env node
/**
 * 旧分组配置迁移工具
 *
 * 把 config.ini 的旧分组节（[merged_regions] / [main_proxy_region_groups] /
 * [custom_groups] / [relay_groups] / [relay_groups_targets] / [proxy_group_defaults]
 * 以及 rules.yaml 的 proxy_groups）迁移为 config/groups.yaml。
 *
 * 用法:
 *   node dist/cli/migrateGroups.js [config.ini] [rules.yaml] [--out groups.yaml]
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { getStr, hasSection, parseIni } from "../utils/ini.js";
import { PROJECT_ROOT } from "../utils/paths.js";
import { dumpYaml } from "../utils/yaml.js";

export interface MigrationResult {
  yaml: string;
  warnings: string[];
}

interface RawRuleGroups {
  proxy_groups?: {
    main_groups?: Array<{ name?: string; type?: string }>;
    special_groups?: Array<{ name?: string; type?: string; proxies?: string[] }>;
  };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 读取旧 config.ini + rules.yaml，生成 groups.yaml 文本与告警。 */
export function migrate(configIniPath: string, rulesPath: string): MigrationResult {
  const warnings: string[] = [];

  const ini = fs.existsSync(configIniPath) ? parseIni(fs.readFileSync(configIniPath, "utf-8")) : {};
  const rules = (
    fs.existsSync(rulesPath) ? parseYaml(fs.readFileSync(rulesPath, "utf-8")) : {}
  ) as RawRuleGroups;

  // 地区组类型与逐地区覆盖
  const regionType =
    getStr(ini, "merged_regions", "default_type").trim() ||
    getStr(ini, "clash", "default_group_type").trim() ||
    "fallback";
  const overrides: Record<string, string> = {};
  if (hasSection(ini, "merged_regions")) {
    for (const [region, value] of Object.entries(ini["merged_regions"])) {
      if (region !== "default_type" && value.trim()) overrides[region] = value.trim();
    }
  }
  if (hasSection(ini, "clash")) {
    for (const [key, value] of Object.entries(ini["clash"])) {
      if (key.startsWith("group_type_") && value.trim()) {
        const region = key.slice("group_type_".length);
        if (!(region in overrides)) overrides[region] = value.trim();
      }
    }
  }

  const defaults = hasSection(ini, "proxy_group_defaults") ? ini["proxy_group_defaults"] : {};
  const regionControl = hasSection(ini, "main_proxy_region_groups")
    ? ini["main_proxy_region_groups"]
    : {};

  const main = (rules.proxy_groups?.main_groups ?? []).map((group) => {
    const name = String(group.name ?? "").trim();
    const entry: Record<string, unknown> = { name, type: String(group.type ?? "select").trim() };
    const control = regionControl[name];
    if (control !== undefined) {
      const trimmed = control.trim();
      entry.regions = trimmed.toLowerCase() === "manual" ? "none" : splitList(trimmed);
    }
    const def = defaults[name]?.trim();
    if (def) entry.default = def;
    return entry;
  });

  const custom: Array<Record<string, unknown>> = [];
  if (hasSection(ini, "custom_groups")) {
    for (const [name, raw] of Object.entries(ini["custom_groups"])) {
      const parts = raw.split(",").map((part) => part.trim());
      if (parts.length < 3) {
        warnings.push(`自定义组 ${name} 配置不完整（少于 3 段），已跳过`);
        continue;
      }
      const regions = parts[2]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      const targets = (parts[3] ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      const item: Record<string, unknown> = { name, type: parts[0], regions };
      if (targets.length > 0) item.targets = targets;
      custom.push(item);
    }
  }

  const special = (rules.proxy_groups?.special_groups ?? []).map((group) => ({
    name: group.name,
    type: group.type ?? "select",
    proxies: group.proxies ?? [],
  }));
  if (hasSection(ini, "relay_groups") && Object.keys(ini["relay_groups"]).length > 0) {
    warnings.push("检测到 [relay_groups]：中继组功能已移除，迁移时忽略（请改用自定义组表达）");
  }
  if (hasSection(ini, "relay_groups_targets")) {
    warnings.push("检测到 [relay_groups_targets]：随中继组功能一并移除，已忽略");
  }
  if (main.length === 0) {
    warnings.push(
      "未在 rules.yaml 找到 proxy_groups.main_groups；请确认传入的是迁移前（含 proxy_groups）的 rules.yaml",
    );
  }

  const doc: Record<string, unknown> = { version: 1 };
  const regionGroups: Record<string, unknown> = {};
  if (regionType !== "fallback") regionGroups.type = regionType;
  if (Object.keys(overrides).length > 0) regionGroups.overrides = overrides;
  if (Object.keys(regionGroups).length > 0) doc.region_groups = regionGroups;
  if (custom.length > 0) doc.custom = custom;
  // 字面量组（原 special_groups）并入 main
  doc.main = [...main, ...special];

  return { yaml: dumpYaml(doc), warnings };
}

function main(): number {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const outIndex = process.argv.indexOf("--out");
  const configIni = positional[0] ?? path.join(PROJECT_ROOT, "config", "config.ini");
  const rulesPath = positional[1] ?? path.join(PROJECT_ROOT, "config", "rules.yaml");
  const outFile =
    outIndex >= 0 && process.argv[outIndex + 1]
      ? path.resolve(process.argv[outIndex + 1])
      : path.join(PROJECT_ROOT, "config", "groups.yaml");

  let result: MigrationResult;
  try {
    result = migrate(configIni, rulesPath);
  } catch (err) {
    console.log(`迁移失败: ${(err as Error).message}`);
    return 2;
  }

  for (const warning of result.warnings) console.log(`WARN  ${warning}`);
  fs.writeFileSync(outFile, result.yaml);
  console.log(`已生成分组配置: ${outFile}`);
  console.log(
    "请检查内容后删除 config.ini 中的旧分组节（[merged_regions] / [main_proxy_region_groups] / [custom_groups] / [relay_groups] / [relay_groups_targets] / [proxy_group_defaults]）与 rules.yaml 的 proxy_groups。",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
