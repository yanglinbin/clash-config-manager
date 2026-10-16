import { writeFileAtomic } from "../utils/atomic.js";
import { parseCidr } from "../utils/cidr.js";
import { pyList } from "../utils/format.js";
import { getBool, getInt, getStr } from "../utils/ini.js";
import { createLogger, type Logger } from "../utils/log.js";
import { CONFIG_INI, OUTPUT_FILE, STATS_FILE } from "../utils/paths.js";
import { escapeRegex } from "../utils/regex.js";
import { isoSeconds } from "../utils/time.js";
import { dumpYaml } from "../utils/yaml.js";

import { ProjectConfig } from "./config.js";
import { BUILTIN_PROXIES, checkRule, parseRule } from "./rules.js";
import type { ClashConfig, GeneratedGroup, GenerationStats, RegionDef } from "./types.js";

/** 允许的代理组类型 */
const VALID_GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance", "relay"]);

/**
 * Clash 配置生成器。
 *
 * 采用订阅链接模式：把订阅链接写入 `proxy-providers`，节点由 Clash 客户端自行拉取，
 * 地区/自定义组通过策略组 `use` + `filter`（按节点名关键词）实现。
 * 分组结构来自 `config/groups.yaml`（见 GroupConfig）。
 */
export class ClashConfigGenerator {
  readonly cfg: ProjectConfig;
  private readonly log: Logger;
  private readonly gitHead: string | null;

  constructor(
    configPath: string = CONFIG_INI,
    log: Logger = createLogger("clash_generator.log"),
    rulesPath?: string,
    gitHead?: string | null,
  ) {
    this.log = log;
    this.gitHead = gitHead ?? null;
    this.cfg = ProjectConfig.load(configPath, log, rulesPath);
  }

  private get ini() {
    return this.cfg.ini;
  }

  private get rules() {
    return this.cfg.rules;
  }

  // ============ 代理组通用 ============

  private createProxyGroupConfig(
    name: string,
    groupType: string,
    proxies: string[],
    testUrl: string,
  ): GeneratedGroup {
    const group: GeneratedGroup = { name, type: groupType, proxies, url: testUrl };
    if (groupType === "fallback") {
      group["timeout"] = 5000;
      group["interval"] = 60;
    } else if (groupType === "url-test") {
      group["tolerance"] = 500;
      group["interval"] = 60;
    } else if (groupType === "load-balance") {
      group["strategy"] = "consistent-hashing";
      group["interval"] = 60;
    }
    return group;
  }

  // ============ 规则 ============

  getRuleProviders(): Record<string, unknown> {
    return this.rules["rule-providers"] ?? {};
  }

  getCustomRules(): string[] {
    const rules: string[] = [];
    const custom = this.rules.custom_rules;
    if (Array.isArray(custom)) rules.push(...custom);
    const ruleset = this.rules.ruleset_rules;
    if (Array.isArray(ruleset)) rules.push(...ruleset);
    return rules;
  }

  // ============ Provider 配置与分组（订阅链接模式） ============

  private get excludePattern(): string {
    const keywords = this.cfg.getExcludeKeywords().filter((k) => k.trim());
    if (keywords.length === 0) return "";
    return keywords.map((k) => escapeRegex(k)).join("|");
  }

  private keywordsToFilter(keywords: string[]): string {
    const parts = keywords.filter((k) => k.trim()).map((k) => escapeRegex(k));
    if (parts.length === 0) return "";
    const regionExpr = parts.join("|");
    const exclude = this.excludePattern;
    if (exclude) return `(?i)(?!.*(?:${exclude})).*(?:${regionExpr})`;
    return `(?i)${regionExpr}`;
  }

  private excludeOnlyFilter(): string {
    const exclude = this.excludePattern;
    if (!exclude) return "";
    return `(?i)^(?!.*(?:${exclude})).*`;
  }

  generateProxyProvidersConfig(): Record<string, unknown> {
    const providers = this.cfg.getProxyProviders();
    const testUrl = this.cfg.getTestUrl();
    const result: Record<string, unknown> = {};
    for (const [name, url] of Object.entries(providers)) {
      result[name] = {
        type: "http",
        url,
        interval: 3600,
        path: `./providers/${name}.yaml`,
        "health-check": { enable: true, url: testUrl, interval: 300 },
      };
      this.log.info(`写入 proxy-provider: ${name}`);
    }
    return result;
  }

  private createProviderGroupConfig(
    name: string,
    groupType: string,
    useProviders: string[],
    testUrl: string,
    filterExpr = "",
  ): GeneratedGroup {
    const group = this.createProxyGroupConfig(name, groupType, [], testUrl);
    delete group.proxies;
    group["use"] = useProviders;
    if (filterExpr) group["filter"] = filterExpr;
    return group;
  }

  /** 每个 `[regions]` 地区生成一个地区组；类型由 groups.yaml 的 overrides/type 决定。 */
  generateRegionGroups(regions: Record<string, RegionDef>): GeneratedGroup[] {
    const groups: GeneratedGroup[] = [];
    const testUrl = this.cfg.getTestUrl();
    const useProviders = this.cfg.providerNames;
    const { type: defaultType, overrides } = this.cfg.groups.regionGroups;

    for (const [regionName, region] of Object.entries(regions)) {
      const filterExpr = this.keywordsToFilter(region.keywords);
      if (!filterExpr) {
        this.log.warn(`地区 ${regionName} 没有可用关键词，跳过该地区组`);
        continue;
      }
      const groupType = overrides[regionName] ?? defaultType;
      groups.push(
        this.createProviderGroupConfig(regionName, groupType, useProviders, testUrl, filterExpr),
      );
      this.log.info(`创建地区组: ${regionName} (类型: ${groupType}, filter 匹配)`);
    }

    this.log.info(`生成了 ${groups.length} 个地区组`);
    return groups;
  }

  /** 自定义组：关键词 = 所引用地区关键词的并集（去重保序）。 */
  buildCustomGroups(regions: Record<string, RegionDef>): GeneratedGroup[] {
    const groups: GeneratedGroup[] = [];
    const testUrl = this.cfg.getTestUrl();
    const useProviders = this.cfg.providerNames;

    for (const def of this.cfg.groups.custom) {
      const keywords: string[] = [];
      for (const regionName of def.regions) {
        const region = regions[regionName];
        if (region) keywords.push(...region.keywords);
      }
      const filterExpr = this.keywordsToFilter([...new Set(keywords)]);
      if (!filterExpr) {
        this.log.warn(`自定义组 ${def.name} 没有有效的地区关键词，跳过`);
        continue;
      }
      groups.push(
        this.createProviderGroupConfig(def.name, def.type, useProviders, testUrl, filterExpr),
      );
      this.log.info(
        `创建自定义节点组: ${def.name} (类型: ${def.type}, 地区: ${def.regions.join("|")})`,
      );
    }

    if (groups.length > 0) this.log.info(`生成了 ${groups.length} 个自定义节点组`);
    return groups;
  }

  /**
   * 主组 proxies 顺序固定为：默认节点 → 地区组 → 自定义组（按 targets 投放）→ DIRECT。
   * 字面量组（带 proxies）直接使用其 proxies，不做派生。
   */
  generateMainProxyGroups(
    regions: Record<string, RegionDef>,
    customGroups: GeneratedGroup[],
  ): GeneratedGroup[] {
    const regionGroupNames = Object.keys(regions);
    const regionNameSet = new Set(regionGroupNames);
    const customNameSet = new Set(customGroups.map((group) => group.name));
    const useProviders = this.cfg.providerNames;
    const excludeFilter = this.excludeOnlyFilter();
    const groups: GeneratedGroup[] = [];

    for (const def of this.cfg.groups.main) {
      if (def.kind === "literal") {
        groups.push({ name: def.name, type: def.type, proxies: [...def.proxies] });
        continue;
      }

      const proxies: string[] = [];
      const seen = new Set<string>();
      const add = (name?: string | null): void => {
        if (name && !seen.has(name)) {
          proxies.push(name);
          seen.add(name);
        }
      };

      if (def.default) {
        if (
          regionNameSet.has(def.default) ||
          customNameSet.has(def.default) ||
          BUILTIN_PROXIES.has(def.default)
        ) {
          add(def.default);
        } else {
          this.log.warn(`主代理组 ${def.name} 配置的默认节点 ${def.default} 不可用，已忽略`);
        }
      }

      const regionNames =
        def.regions === "all" ? regionGroupNames : def.regions === "none" ? [] : def.regions;
      for (const regionName of regionNames) add(regionName);

      // 自定义组：targets 为空 = 投放到全部主组
      for (const customDef of this.cfg.groups.custom) {
        if (!customNameSet.has(customDef.name)) continue;
        if (customDef.targets.length === 0 || customDef.targets.includes(def.name)) {
          add(customDef.name);
        }
      }

      if (def.direct) add("DIRECT");

      const group: GeneratedGroup = { name: def.name, type: def.type, proxies };
      if (def.nodes) {
        group["use"] = useProviders;
        if (excludeFilter) group["filter"] = excludeFilter;
      }
      groups.push(group);
    }

    return groups;
  }

  /** 组装顺序：主组（含特殊组）→ 地区组 → 自定义组。 */
  private generateAllProxyGroups(regions: Record<string, RegionDef>): GeneratedGroup[] {
    const customGroups = this.buildCustomGroups(regions);
    const regionGroups = this.generateRegionGroups(regions);
    const mainGroups = this.generateMainProxyGroups(regions, customGroups);
    return [...mainGroups, ...regionGroups, ...customGroups];
  }

  // ============ 生成 ============

  async generateConfig(): Promise<ClashConfig | null> {
    const providers = this.cfg.getProxyProviders();
    const regions = this.cfg.getRegions();
    if (Object.keys(providers).length === 0) {
      this.log.error("没有配置代理提供者");
      return null;
    }

    this.log.info(
      `找到 ${Object.keys(providers).length} 个代理提供者: ${pyList(Object.keys(providers))}`,
    );
    this.log.info(
      `找到 ${Object.keys(regions).length} 个地区配置: ${pyList(Object.keys(regions))}`,
    );

    const config: ClashConfig = {
      port: getInt(this.ini, "clash", "port", 7890),
      "socks-port": getInt(this.ini, "clash", "socks_port", 7891),
      "allow-lan": getBool(this.ini, "clash", "allow_lan", true),
      mode: getStr(this.ini, "clash", "mode", "Rule"),
      "log-level": getStr(this.ini, "clash", "log_level", "info"),
      "external-controller": getStr(this.ini, "clash", "external_controller", ":9090"),
      "rule-providers": this.getRuleProviders(),
      rules: this.getCustomRules(),
      "proxy-providers": this.generateProxyProvidersConfig(),
      "proxy-groups": this.generateAllProxyGroups(regions),
    };
    return config;
  }

  validateGeneratedConfig(config: ClashConfig): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const groups = config["proxy-groups"] ?? [];
    const groupNames: string[] = [];
    const nameSet = new Set<string>();
    for (const group of groups) {
      const name = group.name ?? "";
      if (!name) errors.push("存在名称为空的代理组");
      else if (nameSet.has(name)) errors.push(`代理组名称重复: ${name}`);
      else {
        groupNames.push(name);
        nameSet.add(name);
      }
    }
    const providerNames = new Set(Object.keys(config["proxy-providers"] ?? {}));

    for (const group of groups) {
      const gname = group.name ?? "?";
      for (const proxy of group.proxies ?? []) {
        if (!BUILTIN_PROXIES.has(proxy) && !nameSet.has(proxy)) {
          errors.push(`代理组 ${gname} 引用了不存在的组: ${proxy}`);
        }
      }
      const gtype = group.type ?? "";
      if (!VALID_GROUP_TYPES.has(gtype)) {
        errors.push(`代理组 ${gname} 使用了无效类型: ${gtype || "(空)"}`);
      }
      for (const useName of group.use ?? []) {
        if (!providerNames.has(useName)) {
          errors.push(`代理组 ${gname} 使用了不存在的提供者: ${useName}`);
        }
      }
      const filterExpr = group.filter;
      if (filterExpr) {
        const err = regexSyntaxError(filterExpr);
        if (err) {
          errors.push(`代理组 ${gname} 的 filter 正则无效: ${filterExpr}（${err}）`);
        }
      }
    }

    const ruleProviderNames = new Set(Object.keys(config["rule-providers"] ?? {}));
    for (const rule of config.rules ?? []) {
      const text = String(rule);
      const error = checkRule(text, nameSet);
      if (error) {
        errors.push(error);
        continue;
      }
      const { type, fields } = parseRule(text);
      if (type === "RULE-SET" && fields.length >= 2 && !ruleProviderNames.has(fields[1])) {
        errors.push(`规则引用了未定义的 rule-provider '${fields[1]}': ${text}`);
      }
      if (
        (type === "IP-CIDR" || type === "IP-CIDR6" || type === "SRC-IP-CIDR") &&
        fields.length >= 2 &&
        parseCidr(fields[1]) === null
      ) {
        errors.push(`规则包含无效 CIDR '${fields[1]}': ${text}`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  saveConfig(config: ClashConfig, outputFile: string = OUTPUT_FILE, durationMs = 0): boolean {
    try {
      const content = dumpYaml(config);
      writeFileAtomic(outputFile, content);

      const fileSize = Buffer.byteLength(content, "utf-8");
      const groups = config["proxy-groups"] ?? [];
      this.log.info(` 配置文件已生成: ${outputFile}`);
      this.log.info(` 文件大小: ${fileSize} 字节`);
      this.log.info(` 代理组数量: ${groups.length}`);
      this.log.info(` 规则数量: ${(config.rules ?? []).length}`);

      const stats: GenerationStats = {
        generated_at: isoSeconds(),
        providers: Object.keys(config["proxy-providers"] ?? {}).length,
        providers_total: this.cfg.proxyProvidersTotal,
        regions: Object.keys(this.cfg.getRegions()).length,
        groups: groups.length,
        rules: (config.rules ?? []).length,
        duration_ms: durationMs,
        git_head: this.gitHead,
        last_error: null,
      };
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2));
      return true;
    } catch (err) {
      this.log.error(`保存配置文件失败: ${(err as Error).message}`);
      return false;
    }
  }

  async run(): Promise<{ ok: boolean; errors: string[] }> {
    const start = Date.now();
    this.log.info(" 开始生成 Clash 配置");
    this.log.info("=".repeat(50));

    let config: ClashConfig | null;
    try {
      config = await this.generateConfig();
    } catch (err) {
      const message = (err as Error).message;
      this.log.error(` 配置生成失败: ${message}`);
      return { ok: false, errors: [message] };
    }
    if (!config) {
      this.log.error(" 配置生成失败");
      return { ok: false, errors: ["配置生成失败（无有效提供者或规则）"] };
    }

    const { ok, errors } = this.validateGeneratedConfig(config);
    if (!ok) {
      this.log.error(` 配置未通过校验（${errors.length} 个问题），保留现有配置文件`);
      for (const err of errors) this.log.error(`  - ${err}`);
      return { ok: false, errors };
    }

    if (this.saveConfig(config, OUTPUT_FILE, Date.now() - start)) {
      this.log.info(` 配置生成完成! 总耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return { ok: true, errors: [] };
    }
    this.log.error(" 配置保存失败");
    return { ok: false, errors: ["配置保存失败"] };
  }
}

/**
 * 校验 filter 正则语法。
 * filter 采用 Mihomo 风格（支持开头内联标志 `(?i)`），JS 不认 `(?i)`，
 * 故校验前先去掉开头的内联标志再做语法检查。
 */
function regexSyntaxError(expr: string): string | null {
  const stripped = expr.replace(/^\(\?[aimsux]+\)/, "");
  try {
    new RegExp(stripped);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
