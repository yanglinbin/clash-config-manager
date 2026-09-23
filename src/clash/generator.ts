import { writeFileAtomic } from "../utils/atomic.js";
import { pyList } from "../utils/format.js";
import { getBool, getInt, getStr, hasSection } from "../utils/ini.js";
import { createLogger, type Logger } from "../utils/log.js";
import { CONFIG_INI, OUTPUT_FILE, STATS_FILE } from "../utils/paths.js";
import { escapeRegex } from "../utils/regex.js";
import { isoSeconds } from "../utils/time.js";
import { dumpYaml } from "../utils/yaml.js";

import { ProjectConfig } from "./config.js";
import { BUILTIN_PROXIES, checkRule } from "./rules.js";
import type {
  ClashConfig,
  CustomGroup,
  GeneratedGroup,
  GenerationStats,
  RegionDef,
} from "./types.js";

/** 允许的代理组类型 */
const VALID_GROUP_TYPES = new Set([
  "select",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
]);

/**
 * Clash 配置生成器。
 *
 * 采用订阅链接模式：把订阅链接写入 `proxy-providers`，节点由 Clash 客户端自行拉取，
 * 地区/自定义组通过策略组 `use` + `filter`（按节点名关键词）实现。
 */
export class ClashConfigGenerator {
  readonly cfg: ProjectConfig;
  private readonly log: Logger;

  constructor(configPath: string = CONFIG_INI, log: Logger = createLogger("clash_generator.log")) {
    this.log = log;
    this.cfg = ProjectConfig.load(configPath, log);
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

  private getProxyDefaults(): Record<string, string> {
    const defaults: Record<string, string> = {};
    if (hasSection(this.ini, "proxy_group_defaults")) {
      for (const [name, value] of Object.entries(this.ini["proxy_group_defaults"])) {
        if (value) defaults[name] = value;
      }
    }
    return defaults;
  }

  // ============ 中继组 ============

  generateRelayGroup(regionGroupNames: string[]): GeneratedGroup[] {
    const relayGroups: GeneratedGroup[] = [];
    if (
      !hasSection(this.ini, "relay_groups") ||
      Object.keys(this.ini["relay_groups"]).length === 0
    ) {
      return relayGroups;
    }

    const testUrl = this.cfg.getTestUrl();
    const relayName = getStr(this.ini, "relay_groups", "name", "统一代理");
    const relayType = getStr(this.ini, "relay_groups", "type", "fallback");
    const includedRegionsStr = getStr(this.ini, "relay_groups", "regions");

    const includedRegions = includedRegionsStr
      ? includedRegionsStr.split(",").map((r) => r.trim())
      : regionGroupNames;

    const known = new Set(regionGroupNames);
    const proxies = includedRegions.filter((r) => known.has(r));
    if (proxies.length === 0) {
      this.log.warn("中继组没有可用的节点，跳过生成");
      return relayGroups;
    }

    const defaultNode = this.getProxyDefaults()[relayName];
    if (defaultNode) {
      if (proxies.includes(defaultNode)) {
        proxies.splice(proxies.indexOf(defaultNode), 1);
        proxies.unshift(defaultNode);
        this.log.info(`为中继组 ${relayName} 设置默认节点: ${defaultNode}`);
      } else {
        this.log.warn(
          `为中继组 ${relayName} 配置的默认节点 ${defaultNode} 不存在于可用节点列表中`,
        );
      }
    }

    const relayGroup: GeneratedGroup = {
      name: relayName,
      type: relayType,
      proxies,
      url: testUrl,
    };
    if (relayType === "fallback") {
      relayGroup["timeout"] = 5000;
      relayGroup["interval"] = 60;
    } else if (relayType === "url-test") {
      relayGroup["tolerance"] = 100;
      relayGroup["interval"] = 30;
    } else if (relayType === "load-balance") {
      relayGroup["strategy"] = "consistent-hashing";
      relayGroup["interval"] = 60;
    }

    relayGroups.push(relayGroup);
    this.log.info(
      `创建中继组: ${relayName} (类型: ${relayType}, 包含 ${proxies.length} 个节点)`,
    );
    return relayGroups;
  }

  // ============ 主代理组 ============

  private shouldIncludeRelayGroup(groupName: string): boolean {
    if (!hasSection(this.ini, "relay_groups_targets")) return true;
    return getStr(this.ini, "relay_groups_targets", groupName).trim().length > 0;
  }

  private getCustomRegionGroups(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (hasSection(this.ini, "main_proxy_region_groups")) {
      for (const [groupName, regionsStr] of Object.entries(
        this.ini["main_proxy_region_groups"],
      )) {
        const regionList = regionsStr.split(",").map((r) => r.trim());
        result[groupName] = regionList;
        this.log.info(`设置 ${groupName} 的自定义地区组: ${pyList(regionList)}`);
      }
    }
    return result;
  }

  private getRelayGroupName(): string | null {
    if (hasSection(this.ini, "relay_groups")) {
      return getStr(this.ini, "relay_groups", "name", "统一代理");
    }
    return null;
  }

  /** 构建一个主代理组的引用顺序（自动去重）。 */
  private buildGroupChain(options: {
    groupName: string;
    defaultNode?: string;
    regionGroupNames: string[];
    customRegionGroups: Record<string, string[]>;
    customGroups: CustomGroup[];
    relayGroupName: string | null;
  }): string[] {
    const { groupName, defaultNode, regionGroupNames, customRegionGroups } = options;
    const { customGroups, relayGroupName } = options;

    const proxies: string[] = [];
    const seen = new Set<string>();
    const add = (name?: string | null): void => {
      if (name && !seen.has(name)) {
        proxies.push(name);
        seen.add(name);
      }
    };

    // 默认节点
    add(defaultNode);

    // 地区组：自定义列表或全部（"manual" 表示手动模式，不自动添加）
    let regionCandidates: string[];
    if (groupName in customRegionGroups) {
      const regionList = customRegionGroups[groupName];
      if (regionList.length === 1 && regionList[0].toLowerCase() === "manual") {
        this.log.info(`主代理组 ${groupName} 设置为手动模式，不自动添加任何地区节点`);
        regionCandidates = [];
      } else {
        const allowed = new Set(regionList);
        regionCandidates = regionGroupNames.filter((r) => allowed.has(r));
      }
    } else {
      regionCandidates = regionGroupNames;
    }
    for (const regionName of regionCandidates) add(regionName);

    // 自定义组：目标组为空表示加入所有主组
    for (const customGroup of customGroups) {
      const targetGroups = customGroup._target_groups ?? [];
      if (targetGroups.length === 0 || targetGroups.includes(groupName)) {
        add(customGroup.name);
      }
    }

    // 中继组（作为默认节点时已置于开头，此处不重复加入）
    if (relayGroupName && !seen.has(relayGroupName)) {
      if (this.shouldIncludeRelayGroup(groupName)) add(relayGroupName);
    }

    add("DIRECT");
    return proxies;
  }

  private getSpecialGroups(): GeneratedGroup[] {
    const special = this.rules.proxy_groups?.special_groups ?? [];
    return special.map((g) => ({ name: g.name, type: g.type, proxies: g.proxies }));
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

  generateRegionGroups(regions: Record<string, RegionDef>): GeneratedGroup[] {
    const groups: GeneratedGroup[] = [];
    const testUrl = this.cfg.getTestUrl();
    const defaultType = getStr(this.ini, "clash", "default_group_type", "fallback");
    const useProviders = this.cfg.providerNames;

    for (const [regionName, region] of Object.entries(regions)) {
      const filterExpr = this.keywordsToFilter(region.keywords);
      if (!filterExpr) {
        this.log.warn(`地区 ${regionName} 没有可用关键词，跳过该地区组`);
        continue;
      }
      const groupType = this.cfg.getGroupType(regionName, defaultType);
      groups.push(
        this.createProviderGroupConfig(regionName, groupType, useProviders, testUrl, filterExpr),
      );
      this.log.info(`创建地区组: ${regionName} (类型: ${groupType}, filter 匹配)`);
    }

    this.log.info(`生成了 ${groups.length} 个地区组`);
    return groups;
  }

  generateCustomGroups(regions: Record<string, RegionDef>): CustomGroup[] {
    const customGroups: CustomGroup[] = [];
    if (!hasSection(this.ini, "custom_groups")) return customGroups;

    const testUrl = this.cfg.getTestUrl();
    const useProviders = this.cfg.providerNames;

    for (const [groupName, configStr] of Object.entries(this.ini["custom_groups"])) {
      try {
        const parts = configStr.split(",").map((p) => p.trim());
        if (parts.length < 3) {
          this.log.warn(`自定义组 ${groupName} 配置不完整，跳过`);
          continue;
        }
        const groupType = parts[0];
        const regionsStr = parts[2];
        const targetGroupsStr = parts.length > 3 ? parts[3] : "";
        const targetGroups = targetGroupsStr
          ? targetGroupsStr.split("|").map((g) => g.trim())
          : [];

        if (!regionsStr) {
          this.log.warn(`自定义组 ${groupName} 没有指定地区，跳过`);
          continue;
        }
        const selectedRegions = regionsStr.split("|").map((r) => r.trim());
        const keywords: string[] = [];
        for (const regionName of selectedRegions) {
          const region = regions[regionName];
          if (region) keywords.push(...region.keywords);
        }
        if (keywords.length === 0) {
          this.log.warn(`自定义组 ${groupName} 没有有效的地区关键词，跳过`);
          continue;
        }

        const group = this.createProviderGroupConfig(
          groupName,
          groupType,
          useProviders,
          testUrl,
          this.keywordsToFilter(keywords),
        ) as CustomGroup;
        group._target_groups = targetGroups;
        customGroups.push(group);
        this.log.info(
          `创建自定义节点组: ${groupName} (类型: ${groupType}, 地区: ${regionsStr}, filter 匹配)`,
        );
      } catch (err) {
        this.log.error(`解析自定义组 ${groupName} 配置失败: ${(err as Error).message}`);
        continue;
      }
    }

    if (customGroups.length > 0) {
      this.log.info(`生成了 ${customGroups.length} 个自定义节点组`);
    }
    return customGroups;
  }

  generateMainProxyGroups(
    regionGroupNames: string[],
    customGroups: CustomGroup[],
    useProviders: string[],
  ): GeneratedGroup[] {
    const proxyDefaults = this.getProxyDefaults();
    const customRegionGroups = this.getCustomRegionGroups();
    const relayGroupName = this.getRelayGroupName();
    const excludeFilter = this.excludeOnlyFilter();
    const mainGroups: GeneratedGroup[] = [];

    for (const groupConfig of this.rules.proxy_groups?.main_groups ?? []) {
      const groupName = groupConfig.name;
      const proxies = this.buildGroupChain({
        groupName,
        defaultNode: proxyDefaults[groupName],
        regionGroupNames,
        customRegionGroups,
        customGroups,
        relayGroupName,
      });
      const group: GeneratedGroup = {
        name: groupName,
        type: groupConfig.type,
        proxies,
        use: useProviders,
      };
      if (excludeFilter) group["filter"] = excludeFilter;
      mainGroups.push(group);
    }

    mainGroups.push(...this.getSpecialGroups());
    return mainGroups;
  }

  /** 按固定顺序合并：中继组 → 主组 → 地区组 → 自定义组（去掉内部字段）。 */
  private static assembleGroups(
    relayGroups: GeneratedGroup[],
    mainGroups: GeneratedGroup[],
    regionGroups: GeneratedGroup[],
    customGroups: CustomGroup[],
  ): GeneratedGroup[] {
    const all: GeneratedGroup[] = [];
    all.push(...relayGroups);
    all.push(...mainGroups);
    all.push(...regionGroups);
    for (const custom of customGroups) {
      all.push(stripInternalFields(custom));
    }
    return all;
  }

  private generateAllProxyGroups(regions: Record<string, RegionDef>): GeneratedGroup[] {
    const regionGroupNames = Object.keys(regions);
    const useProviders = this.cfg.providerNames;

    const relayGroups = this.generateRelayGroup(regionGroupNames);
    const customGroups = this.generateCustomGroups(regions);
    const regionGroups = this.generateRegionGroups(regions);
    const mainGroups = this.generateMainProxyGroups(
      regionGroupNames,
      customGroups,
      useProviders,
    );
    return ClashConfigGenerator.assembleGroups(
      relayGroups,
      mainGroups,
      regionGroups,
      customGroups,
    );
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

    for (const rule of config.rules ?? []) {
      const error = checkRule(String(rule), nameSet);
      if (error) errors.push(error);
    }

    return { ok: errors.length === 0, errors };
  }

  saveConfig(config: ClashConfig, outputFile: string = OUTPUT_FILE): boolean {
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
      };
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2));
      return true;
    } catch (err) {
      this.log.error(`保存配置文件失败: ${(err as Error).message}`);
      return false;
    }
  }

  async run(): Promise<boolean> {
    const start = Date.now();
    this.log.info(" 开始生成 Clash 配置");
    this.log.info("=".repeat(50));

    const config = await this.generateConfig();
    if (!config) {
      this.log.error(" 配置生成失败");
      return false;
    }

    const { ok, errors } = this.validateGeneratedConfig(config);
    if (!ok) {
      this.log.error(` 配置未通过校验（${errors.length} 个问题），保留现有配置文件`);
      for (const err of errors) this.log.error(`  - ${err}`);
      return false;
    }

    if (this.saveConfig(config)) {
      this.log.info(` 配置生成完成! 总耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return true;
    }
    this.log.error(" 配置保存失败");
    return false;
  }
}

function stripInternalFields(group: CustomGroup): GeneratedGroup {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(group)) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out as GeneratedGroup;
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
