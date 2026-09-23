import { stringify } from "yaml";

/**
 * 统一的 YAML 序列化选项：
 * - lineWidth: 0 关闭折行（Python 默认 80 会折行，这里输出更干净）
 * - aliasDuplicateObjects: 重复对象（如各主组共享的 use 列表）输出锚点/别名
 * - 中文等非 ASCII 原样输出，不转义
 */
export function dumpYaml(value: unknown): string {
  return stringify(value, {
    lineWidth: 0,
    aliasDuplicateObjects: true,
    indent: 2,
  });
}
