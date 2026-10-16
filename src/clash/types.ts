/** Clash 配置与 rules.yaml 的类型定义。 */

export interface RuleProvider {
  type: string;
  behavior: string;
  url?: string;
  path: string;
  interval?: number;
}

export interface RulesConfig {
  "rule-providers"?: Record<string, RuleProvider>;
  custom_rules?: string[];
  ruleset_rules?: string[];
}

export interface GeneratedGroup {
  name: string;
  type: string;
  proxies?: string[];
  use?: string[];
  filter?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ClashConfig {
  port: number;
  "socks-port": number;
  "allow-lan": boolean;
  mode: string;
  "log-level": string;
  "external-controller": string;
  "rule-providers": Record<string, unknown>;
  rules: string[];
  "proxy-providers"?: Record<string, unknown>;
  "proxy-groups"?: GeneratedGroup[];
}

export interface GenerationStats {
  generated_at: string;
  providers: number;
  providers_total: number;
  regions: number;
  groups: number;
  rules: number;
  duration_ms?: number;
  git_head?: string | null;
  last_error?: string | null;
}

export interface RegionDef {
  keywords: string[];
}

/** ===== 分组配置（config/groups.yaml） ===== */

/** Clash 代理组类型。 */
export type GroupType = "select" | "url-test" | "fallback" | "load-balance" | "relay";

/** 地区组统一设置。 */
export interface RegionGroupSettings {
  type: GroupType;
  overrides: Record<string, GroupType>;
}

/** 自定义组。 */
export interface CustomGroupConfig {
  name: string;
  type: GroupType;
  regions: string[];
  /** 空数组 = 投放到全部主组 */
  targets: string[];
}

/** 派生式主组：成员由 default + regions + 自定义组(targets) + DIRECT 派生。 */
export interface DerivedGroupConfig {
  kind: "derived";
  name: string;
  type: GroupType;
  regions: "all" | "none" | string[];
  nodes: boolean;
  direct: boolean;
  default?: string;
}

/** 字面量主组：成员就是 proxies，不再派生。 */
export interface LiteralGroupConfig {
  kind: "literal";
  name: string;
  type: GroupType;
  proxies: string[];
}

/** 主组（派生式或字面量式）。 */
export type MainGroupConfig = DerivedGroupConfig | LiteralGroupConfig;

/** groups.yaml 填好缺省后的规范模型。 */
export interface GroupConfig {
  regionGroups: RegionGroupSettings;
  custom: CustomGroupConfig[];
  main: MainGroupConfig[];
}

/** groups.yaml 的原始（未填缺省）结构。 */
export interface RawGroupsConfig {
  version?: number;
  region_groups?: { type?: GroupType; overrides?: Record<string, GroupType> };
  custom?: Array<{ name: string; type: GroupType; regions: string[]; targets?: string[] }>;
  main?: Array<{
    name: string;
    type: GroupType;
    proxies?: string[];
    regions?: "all" | "none" | string[];
    nodes?: boolean;
    direct?: boolean;
    default?: string;
  }>;
}
