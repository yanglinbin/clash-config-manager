#!/usr/bin/env node
/**
 * Clash 规则文件 lint 工具
 *
 * 检查 config/rules.yaml 中的常见问题：
 *   - 完全重复的规则行（error）
 *   - 被其他网段包含的 CIDR（error，冗余）
 *   - 部分重叠的 CIDR（warning，可能有意为之）
 *   - DOMAIN-SUFFIX 中的无效 "*. " 前缀（error）
 *   - 规则行逗号后带空格（warning，风格问题）
 *   - 未知规则类型（error）
 *   - 规则目标代理组不存在（error）
 *   - 同一域名被路由到不同代理组（warning，可能存在冲突）
 *
 * 用法:
 *   node dist/cli/lint.js [rules.yaml]
 * 退出码: 0=通过(仅 warning 也视为通过), 1=存在 error, 2=文件/解析错误
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { checkRule, parseRule } from "../clash/rules.js";
import { isSubnetOf, overlaps, parseCidr, type Cidr } from "../utils/cidr.js";
import { pyList } from "../utils/format.js";
import { PROJECT_ROOT } from "../utils/paths.js";

interface Parsed {
  rule: string;
  type: string;
  fields: string[];
}

function collectGroupNames(data: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const proxyGroups = (data["proxy_groups"] ?? {}) as Record<string, unknown>;
  for (const key of ["main_groups", "special_groups"]) {
    const groups = proxyGroups[key];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group && typeof group === "object" && typeof (group as any).name === "string") {
        names.add((group as any).name);
      }
    }
  }
  return names;
}

function sameNet(a: Cidr, b: Cidr): boolean {
  return a.version === b.version && a.start === b.start && a.prefix === b.prefix;
}

export function lint(filePath: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const data = parseYaml(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("rules.yaml 顶层必须是映射");
  }
  const doc = data as Record<string, unknown>;
  const groupNames = collectGroupNames(doc);

  const allRules: string[] = [];
  if (Array.isArray(doc["custom_rules"])) allRules.push(...(doc["custom_rules"] as string[]));
  if (Array.isArray(doc["ruleset_rules"])) allRules.push(...(doc["ruleset_rules"] as string[]));

  // 一次性解析每行规则，避免同一行被 parseRule 多次解析
  const parsed: Parsed[] = allRules.map((rule) => {
    const { type, fields } = parseRule(rule);
    return { rule, type, fields };
  });

  // 1. 完全重复
  const seen = new Map<string, number>();
  for (const { rule } of parsed) {
    const key = rule.trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [rule, count] of seen) {
    if (count > 1) errors.push(`完全重复的规则行（${count} 次）: ${rule}`);
  }

  // 2. CIDR 包含/重叠
  const cidrRules: Array<{ rule: string; cidr: string; group: string }> = [];
  for (const { rule, type, fields } of parsed) {
    if ((type === "IP-CIDR" || type === "IP-CIDR6") && fields.length >= 3) {
      cidrRules.push({ rule, cidr: fields[1], group: fields[2] });
    }
  }
  for (let i = 0; i < cidrRules.length; i += 1) {
    const a = cidrRules[i];
    const netA = parseCidr(a.cidr);
    if (netA === null) {
      errors.push(`无效 CIDR: ${a.cidr}（${a.rule}）`);
      continue;
    }
    for (let j = i + 1; j < cidrRules.length; j += 1) {
      const b = cidrRules[j];
      if (a.group !== b.group) continue;
      const netB = parseCidr(b.cidr);
      if (netB === null) {
        errors.push(`无效 CIDR: ${b.cidr}（${b.rule}）`);
        continue;
      }
      if (netA.version !== netB.version) continue;
      if (isSubnetOf(netA, netB) && !sameNet(netA, netB)) {
        errors.push(`CIDR 冗余（${a.cidr} 已被 ${b.cidr} 包含）: ${a.rule}`);
      } else if (isSubnetOf(netB, netA) && !sameNet(netA, netB)) {
        errors.push(`CIDR 冗余（${b.cidr} 已被 ${a.cidr} 包含）: ${b.rule}`);
      } else if (overlaps(netA, netB)) {
        warnings.push(`CIDR 部分重叠: ${a.cidr} <-> ${b.cidr}`);
      }
    }
  }

  // 3. 规则格式与目标组
  const domainTargets = new Map<string, Set<string>>();
  for (const { rule, type, fields } of parsed) {
    const error = checkRule(rule, groupNames);
    if (error) {
      errors.push(error);
      continue;
    }
    if (type === "DOMAIN-SUFFIX" && fields.length >= 2 && fields[1].startsWith("*.")) {
      errors.push(`DOMAIN-SUFFIX 无需 '*. ' 前缀: ${rule}`);
    }
    if (
      (type === "DOMAIN" || type === "DOMAIN-SUFFIX" || type === "DOMAIN-KEYWORD") &&
      fields.length >= 3
    ) {
      const key = `${type}:${fields[1]}`;
      const set = domainTargets.get(key) ?? new Set<string>();
      set.add(fields[2]);
      domainTargets.set(key, set);
    }
    if (/,\s/.test(rule)) {
      warnings.push(`规则逗号后带空格（建议去掉）: ${rule}`);
    }
  }

  // 4. 同一规则目标路由到不同组（冲突提示）
  for (const key of [...domainTargets.keys()].sort()) {
    const targets = domainTargets.get(key)!;
    if (targets.size > 1) {
      warnings.push(`同一规则目标被路由到多个组 ${pyList([...targets].sort())}: ${key}`);
    }
  }

  return { errors, warnings };
}

function main(): number {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const target = args[0] ?? "config/rules.yaml";
  const filePath = path.isAbsolute(target) ? target : path.join(PROJECT_ROOT, target);

  if (!fs.existsSync(filePath)) {
    console.log(`文件不存在: ${filePath}`);
    return 2;
  }

  let result: { errors: string[]; warnings: string[] };
  try {
    result = lint(filePath);
  } catch (err) {
    console.log(`解析失败: ${(err as Error).message}`);
    return 2;
  }

  for (const w of result.warnings) console.log(`WARN  ${w}`);
  for (const e of result.errors) console.log(`ERROR ${e}`);
  console.log(
    `\n检查完成: ${result.errors.length} 个错误, ${result.warnings.length} 个警告`,
  );
  return result.errors.length > 0 ? 1 : 0;
}

// 仅作为 CLI 直接运行时执行（被测试/其它模块 import 时不退出进程）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
