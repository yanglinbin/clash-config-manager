import fs from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import { ConfigError } from "../utils/errors.js";
import { getStr, hasSection, parseIni, type IniData } from "../utils/ini.js";
import { pyList } from "../utils/format.js";
import { PROJECT_ROOT, RULES_SCHEMA_FILE } from "../utils/paths.js";
import type { Logger } from "../utils/log.js";
import { loadGroupConfig } from "./groups.js";
import type { GroupConfig, RegionDef, RulesConfig } from "./types.js";

export { ConfigError };

let rulesValidator: ValidateFunction | null | undefined;

/** 懒加载并缓存 rules.schema.json 的校验器（缺失或非法时返回 null 并跳过）。 */
function getRulesValidator(log?: Logger): ValidateFunction | null {
  if (rulesValidator !== undefined) return rulesValidator;
  if (!fs.existsSync(RULES_SCHEMA_FILE)) {
    log?.warn(`规则 schema 不存在，跳过 schema 校验: ${RULES_SCHEMA_FILE}`);
    rulesValidator = null;
    return rulesValidator;
  }
  try {
    const schema = JSON.parse(fs.readFileSync(RULES_SCHEMA_FILE, "utf-8"));
    rulesValidator = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(
      schema,
    );
  } catch (err) {
    log?.warn(`加载规则 schema 失败，跳过 schema 校验: ${(err as Error).message}`);
    rulesValidator = null;
  }
  return rulesValidator;
}

export function loadIni(filePath: string): IniData {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`配置文件 ${filePath} 不存在`);
  }
  return parseIni(fs.readFileSync(filePath, "utf-8"));
}

export function loadRulesConfig(filePath: string, log?: Logger): RulesConfig {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`规则配置文件 ${filePath} 不存在`);
  }
  let data: unknown;
  try {
    data = parseYaml(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new ConfigError(`规则配置文件格式错误: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("rules.yaml 顶层必须是映射");
  }

  const validate = getRulesValidator(log);
  if (validate && !validate(data)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "无效"}`)
      .join("; ");
    throw new ConfigError(`规则文件未通过 schema 校验: ${details}`);
  }

  return data as RulesConfig;
}

/**
 * 项目配置（config.ini + rules.yaml）及其派生值缓存。
 * 派生值在一次生成内复用，避免重复解析与日志噪声。
 */
export class ProjectConfig {
  private providersCache?: Record<string, string>;
  private regionsCache?: Record<string, RegionDef>;
  private excludeKeywordsCache?: string[];
  private testUrlCache?: string;

  /** 分组配置（config/groups.yaml）。 */
  readonly groups: GroupConfig;
  readonly groupsFile: string;

  private constructor(
    readonly ini: IniData,
    readonly rules: RulesConfig,
    readonly rulesFile: string,
    private readonly log: Logger,
  ) {
    const rawGroups = getStr(ini, "files", "groups_config", "config/groups.yaml");
    this.groupsFile = path.isAbsolute(rawGroups) ? rawGroups : path.join(PROJECT_ROOT, rawGroups);
    this.groups = loadGroupConfig(this.groupsFile, new Set(Object.keys(this.getRegions())), log);
  }

  static load(configIniPath: string, log: Logger, rulesPathOverride?: string): ProjectConfig {
    const ini = loadIni(configIniPath);
    log.info(`已加载配置文件: ${configIniPath}`);

    const rawRules = rulesPathOverride ?? getStr(ini, "files", "rules_config", "config/rules.yaml");
    const rulesFile = path.isAbsolute(rawRules) ? rawRules : path.join(PROJECT_ROOT, rawRules);
    const rules = loadRulesConfig(rulesFile, log);
    log.info(`已加载规则配置文件: ${rulesFile}`);

    return new ProjectConfig(ini, rules, rulesFile, log);
  }

  private get activeProvider(): string | null {
    if (hasSection(this.ini, "provider_control")) {
      const value = getStr(this.ini, "provider_control", "active_provider").trim();
      if (value) return value.toUpperCase();
    }
    return null;
  }

  /** 活动提供者配置（名称转大写，只返回活动提供者），结果缓存。 */
  getProxyProviders(): Record<string, string> {
    if (this.providersCache) return this.providersCache;

    const all: Record<string, string> = {};
    if (hasSection(this.ini, "proxy_providers")) {
      for (const [name, url] of Object.entries(this.ini["proxy_providers"])) {
        all[name.toUpperCase()] = url;
      }
    }

    const active = this.activeProvider;
    if (active === null) {
      this.log.error("未配置 active_provider（请设置 [provider_control] active_provider）");
      return (this.providersCache = {});
    }
    if (!(active in all)) {
      this.log.error(
        `active_provider 指定的提供者不存在: ${active}` +
          `（可用的提供者: ${pyList(Object.keys(all).sort())}）`,
      );
      return (this.providersCache = {});
    }

    const others = Object.keys(all)
      .filter((n) => n !== active)
      .sort();
    this.log.info(`只使用提供者: ${active}（其他提供者不参与生成: ${pyList(others)}）`);
    return (this.providersCache = { [active]: all[active] });
  }

  /** 参与生成的提供者名称列表。 */
  get providerNames(): string[] {
    return Object.keys(this.getProxyProviders());
  }

  /** [proxy_providers] 中配置的提供者总数（含未启用）。 */
  get proxyProvidersTotal(): number {
    if (!hasSection(this.ini, "proxy_providers")) return 0;
    return Object.keys(this.ini["proxy_providers"]).length;
  }

  /** 地区配置（全部字段均为匹配关键词），结果缓存。 */
  getRegions(): Record<string, RegionDef> {
    if (this.regionsCache) return this.regionsCache;

    const regions: Record<string, RegionDef> = {};
    if (hasSection(this.ini, "regions")) {
      for (const [region, value] of Object.entries(this.ini["regions"])) {
        const keywords = value
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0);
        if (keywords.length === 0) {
          this.log.warn(`地区 ${region} 未配置关键词，已跳过`);
          continue;
        }
        regions[region] = { keywords };
      }
    }
    return (this.regionsCache = regions);
  }

  /** 全局排除关键词，结果缓存。 */
  getExcludeKeywords(): string[] {
    if (this.excludeKeywordsCache) return this.excludeKeywordsCache;

    let keywords: string[] = [];
    if (hasSection(this.ini, "filter")) {
      const raw = getStr(this.ini, "filter", "exclude_keywords");
      if (raw) keywords = raw.split(",").map((k) => k.trim());
    }
    return (this.excludeKeywordsCache = keywords);
  }

  /** 测速 URL，结果缓存。 */
  getTestUrl(): string {
    if (this.testUrlCache !== undefined) return this.testUrlCache;
    return (this.testUrlCache = getStr(
      this.ini,
      "clash",
      "test_url",
      "http://connectivitycheck.gstatic.com/generate_204",
    ));
  }
}
