/**
 * Clash 规则公共常量与解析/校验工具。
 * 供配置生成器与规则 lint 工具共用，避免校验逻辑两处维护。
 */

/** Clash 内置代理关键字（引用检查时无需匹配代理组/节点） */
export const BUILTIN_PROXIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "GLOBAL",
]);

/** 允许的规则类型 */
export const VALID_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-REGEX",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "GEOSITE",
  "SRC-IP-CIDR",
  "SRC-PORT",
  "DST-PORT",
  "SRC-IP-ASN",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "RULE-SET",
  "MATCH",
  "AND",
  "OR",
  "NOT",
  "SUB-RULE",
]);

export interface ParsedRule {
  type: string;
  fields: string[];
}

/** 把规则行拆成 { type, fields }，每个字段去掉首尾空白。 */
export function parseRule(rule: string): ParsedRule {
  const fields = String(rule).split(",").map((part) => part.trim());
  return { type: fields[0], fields };
}

/** 规则指向的代理组（MATCH 在第 2 列，其余规则在第 3 列）。 */
export function ruleTarget(type: string, fields: string[]): string | null {
  if (type === "MATCH") return fields.length >= 2 ? fields[1] : null;
  return fields.length >= 3 ? fields[2] : null;
}

/** 校验单条规则的类型、格式与目标代理组；合法返回 null，否则返回错误信息。 */
export function checkRule(rule: string, validGroups: Set<string>): string | null {
  const { type, fields } = parseRule(rule);
  if (!VALID_RULE_TYPES.has(type)) return `未知规则类型: ${rule}`;
  if (fields.length < 2) return `规则格式不完整: ${rule}`;
  const target = ruleTarget(type, fields);
  if (target === null) return `规则缺少目标代理组: ${rule}`;
  if (!validGroups.has(target) && !BUILTIN_PROXIES.has(target)) {
    return `规则指向不存在的代理组 '${target}': ${rule}`;
  }
  return null;
}
