/** Clash 配置与 rules.yaml 的类型定义。 */

export type ProxyGroupType =
  | "select"
  | "url-test"
  | "fallback"
  | "load-balance"
  | "relay";

export interface MainGroupDef {
  name: string;
  type: ProxyGroupType;
  description?: string;
}

export interface SpecialGroupDef {
  name: string;
  type: ProxyGroupType;
  proxies: string[];
  description?: string;
}

export interface ProxyGroupsConfig {
  main_groups?: MainGroupDef[];
  special_groups?: SpecialGroupDef[];
}

export interface RuleProvider {
  type: string;
  behavior: string;
  url?: string;
  path: string;
  interval?: number;
}

export interface RulesConfig {
  "rule-providers"?: Record<string, RuleProvider>;
  proxy_groups?: ProxyGroupsConfig;
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

/** 生成配置时内部携带的临时字段（输出前移除） */
export interface CustomGroup extends GeneratedGroup {
  _target_groups?: string[];
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
}

export interface RegionDef {
  keywords: string[];
}
