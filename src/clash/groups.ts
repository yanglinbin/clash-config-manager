import fs from "node:fs";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import { ConfigError } from "../utils/errors.js";
import type { Logger } from "../utils/log.js";
import { GROUPS_SCHEMA_FILE } from "../utils/paths.js";
import { BUILTIN_PROXIES } from "./rules.js";
import type {
  CustomGroupConfig,
  GroupConfig,
  GroupType,
  MainGroupConfig,
  RawGroupsConfig,
  RegionGroupSettings,
} from "./types.js";

const DEFAULT_REGION_TYPE: GroupType = "fallback";

let groupsValidator: ValidateFunction | null | undefined;

/** 懒加载并缓存 groups.schema.json 的校验器（缺失/非法时返回 null 跳过）。 */
function getGroupsValidator(log?: Logger): ValidateFunction | null {
  if (groupsValidator !== undefined) return groupsValidator;
  if (!fs.existsSync(GROUPS_SCHEMA_FILE)) {
    log?.warn(`分组 schema 不存在，跳过 schema 校验: ${GROUPS_SCHEMA_FILE}`);
    groupsValidator = null;
    return groupsValidator;
  }
  try {
    const schema = JSON.parse(fs.readFileSync(GROUPS_SCHEMA_FILE, "utf-8"));
    groupsValidator = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(
      schema,
    );
  } catch (err) {
    log?.warn(`加载分组 schema 失败，跳过 schema 校验: ${(err as Error).message}`);
    groupsValidator = null;
  }
  return groupsValidator;
}

/**
 * 加载并规范化 config/groups.yaml：
 * - 通过 JSON Schema 校验结构；
 * - 填充缺省（region type、regions=all、nodes/direct=true、targets=全部主组）；
 * - 校验名称唯一性与引用完整性（地区/自定义组/主组/默认节点）。
 *
 * @param regionNames config.ini `[regions]` 中定义的全部地区名
 */
export function loadGroupConfig(
  groupsPath: string,
  regionNames: Set<string>,
  log?: Logger,
): GroupConfig {
  if (!fs.existsSync(groupsPath)) {
    throw new ConfigError(`分组配置文件 ${groupsPath} 不存在`);
  }

  let data: unknown;
  try {
    data = parseYaml(fs.readFileSync(groupsPath, "utf-8"));
  } catch (err) {
    throw new ConfigError(`分组配置文件格式错误: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("groups.yaml 顶层必须是映射");
  }

  const validate = getGroupsValidator(log);
  if (validate && !validate(data)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "无效"}`)
      .join("; ");
    throw new ConfigError(`分组配置未通过 schema 校验: ${details}`);
  }

  const raw = data as RawGroupsConfig;
  const config = normalize(raw);
  validateReferences(config, regionNames);

  log?.info(
    `已加载分组配置: ${groupsPath}（主组 ${config.main.length} / 自定义 ${config.custom.length}）`,
  );
  return config;
}

function normalize(raw: RawGroupsConfig): GroupConfig {
  const regionGroups: RegionGroupSettings = {
    type: raw.region_groups?.type ?? DEFAULT_REGION_TYPE,
    overrides: { ...(raw.region_groups?.overrides ?? {}) },
  };

  const custom: CustomGroupConfig[] = (raw.custom ?? []).map((group) => ({
    name: group.name,
    type: group.type,
    regions: [...group.regions],
    targets: [...(group.targets ?? [])],
  }));

  const main: MainGroupConfig[] = (raw.main ?? []).map((group) => {
    if (group.proxies) {
      return {
        kind: "literal",
        name: group.name,
        type: group.type,
        proxies: [...group.proxies],
      };
    }
    return {
      kind: "derived",
      name: group.name,
      type: group.type,
      regions: group.regions ?? "all",
      nodes: group.nodes ?? true,
      direct: group.direct ?? true,
      default: group.default,
    };
  });

  return { regionGroups, custom, main };
}

/** 名称唯一 + 引用完整性校验；任一条失败抛 ConfigError。 */
function validateReferences(config: GroupConfig, regionNames: Set<string>): void {
  const errors: string[] = [];
  const mainNames = new Set(config.main.map((group) => group.name));
  const derivedNames = new Set(
    config.main.filter((group) => group.kind === "derived").map((group) => group.name),
  );
  const customNames = new Set(config.custom.map((group) => group.name));
  const groupNames = new Set<string>([...mainNames, ...customNames, ...regionNames]);

  // 名称唯一性（主组/自定义/地区组共享同一命名空间）
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  config.main.forEach((group) => count(group.name));
  config.custom.forEach((group) => count(group.name));
  for (const name of regionNames) count(name);
  for (const [name, n] of counts) {
    if (n > 1) errors.push(`代理组名称重复: ${name}`);
    if (BUILTIN_PROXIES.has(name)) errors.push(`代理组名称不能使用内置关键字: ${name}`);
  }

  for (const group of config.main) {
    if (group.kind === "literal") {
      for (const proxy of group.proxies) {
        if (proxy === group.name) {
          errors.push(`字面量组 ${group.name} 不能引用自身`);
        } else if (!BUILTIN_PROXIES.has(proxy) && !groupNames.has(proxy)) {
          errors.push(`字面量组 ${group.name} 引用了不存在的组: ${proxy}`);
        }
      }
      continue;
    }

    if (typeof group.regions === "string") {
      if (group.regions !== "all" && group.regions !== "none") {
        errors.push(`主组 ${group.name} 的 regions 取值非法: ${group.regions}`);
      }
    } else {
      for (const region of group.regions) {
        if (!regionNames.has(region)) {
          errors.push(`主组 ${group.name} 引用了不存在的地区: ${region}`);
        }
      }
    }
    if (
      group.default &&
      !regionNames.has(group.default) &&
      !customNames.has(group.default) &&
      !BUILTIN_PROXIES.has(group.default)
    ) {
      errors.push(`主组 ${group.name} 的默认节点不存在: ${group.default}`);
    }
  }

  for (const group of config.custom) {
    for (const region of group.regions) {
      if (!regionNames.has(region)) {
        errors.push(`自定义组 ${group.name} 引用了不存在的地区: ${region}`);
      }
    }
    for (const target of group.targets) {
      if (!derivedNames.has(target)) {
        errors.push(`自定义组 ${group.name} 的目标主组不存在或不可作为目标: ${target}`);
      }
    }
  }

  for (const region of Object.keys(config.regionGroups.overrides)) {
    if (!regionNames.has(region)) {
      errors.push(`region_groups.overrides 引用了不存在的地区: ${region}`);
    }
  }

  if (config.main.length === 0) errors.push("至少需要定义一个主组");

  if (errors.length > 0) {
    throw new ConfigError(`分组配置校验失败: ${errors.join("; ")}`);
  }
}
