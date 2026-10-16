import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "../src/clash/config.js";
import { loadGroupConfig } from "../src/clash/groups.js";

const dirs: string[] = [];
const REGIONS = new Set(["香港", "日本", "美国"]);

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function writeGroups(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groups-"));
  dirs.push(dir);
  const file = path.join(dir, "groups.yaml");
  fs.writeFileSync(file, content);
  return file;
}

const VALID = `main:
  - name: 海外代理
    type: select
    default: 香港
  - name: 全球直连
    type: select
    regions: none
  - name: 广告拦截
    type: select
    proxies: [REJECT, DIRECT]
custom:
  - name: AI专用
    type: fallback
    regions: [香港, 日本]
`;

describe("loadGroupConfig", () => {
  it("填充缺省并规范化", () => {
    const config = loadGroupConfig(writeGroups(VALID), REGIONS);
    expect(config.regionGroups.type).toBe("fallback");
    expect(config.regionGroups.overrides).toEqual({});

    const overseas = config.main.find((group) => group.name === "海外代理")!;
    expect(overseas.kind).toBe("derived");
    if (overseas.kind === "derived") {
      expect(overseas.regions).toBe("all");
      expect(overseas.nodes).toBe(true);
      expect(overseas.direct).toBe(true);
      expect(overseas.default).toBe("香港");
    }

    const direct = config.main.find((group) => group.name === "全球直连")!;
    expect(direct.kind === "derived" && direct.regions).toBe("none");

    const literal = config.main.find((group) => group.name === "广告拦截")!;
    expect(literal.kind).toBe("literal");
    if (literal.kind === "literal") {
      expect(literal.proxies).toEqual(["REJECT", "DIRECT"]);
    }

    expect(config.custom[0].targets).toEqual([]); // 空 = 全部主组
  });

  it("region_groups 覆盖生效", () => {
    const file = writeGroups(
      "region_groups:\n  type: url-test\n  overrides:\n    香港: select\nmain:\n  - name: 主\n    type: select\n",
    );
    const config = loadGroupConfig(file, REGIONS);
    expect(config.regionGroups.type).toBe("url-test");
    expect(config.regionGroups.overrides).toEqual({ 香港: "select" });
  });

  it("缺少主组 → 校验失败", () => {
    expect(() => loadGroupConfig(writeGroups("main: []\n"), REGIONS)).toThrow(ConfigError);
  });

  it("非法组类型 → schema 失败", () => {
    const file = writeGroups("main:\n  - name: 主\n    type: bogus\n");
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(ConfigError);
  });

  it("字面量与派生字段混写 → schema 失败", () => {
    const file = writeGroups(
      "main:\n  - name: 主\n    type: select\n    proxies: [REJECT]\n    regions: all\n",
    );
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(ConfigError);
  });

  it("引用不存在的地区 → 失败", () => {
    const file = writeGroups("main:\n  - name: 主\n    type: select\n    regions: [火星]\n");
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/不存在的地区/);
  });

  it("字面量组引用不存在的组 → 失败", () => {
    const file = writeGroups(
      "main:\n  - name: 主\n    type: select\n  - name: 拦截\n    type: select\n    proxies: [不存在]\n",
    );
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/引用了不存在的组/);
  });

  it("自定义组目标主组不存在 → 失败", () => {
    const file = writeGroups(
      "main:\n  - name: 主\n    type: select\ncustom:\n  - name: C\n    type: fallback\n    regions: [香港]\n    targets: [被删掉的主组]\n",
    );
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/目标主组不存在或不可作为目标/);
  });

  it("自定义组不能投放到字面量组 → 失败", () => {
    const file = writeGroups(
      "main:\n  - name: 主\n    type: select\n  - name: 拦截\n    type: select\n    proxies: [REJECT]\ncustom:\n  - name: C\n    type: fallback\n    regions: [香港]\n    targets: [拦截]\n",
    );
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/目标主组不存在或不可作为目标/);
  });

  it("名称重复 → 失败", () => {
    const file = writeGroups(
      "main:\n  - name: 主\n    type: select\ncustom:\n  - name: 主\n    type: fallback\n    regions: [香港]\n",
    );
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/名称重复/);
  });

  it("使用内置关键字作组名 → 失败", () => {
    const file = writeGroups("main:\n  - name: DIRECT\n    type: select\n");
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/内置关键字/);
  });

  it("默认节点不存在 → 失败", () => {
    const file = writeGroups("main:\n  - name: 主\n    type: select\n    default: 不存在\n");
    expect(() => loadGroupConfig(file, REGIONS)).toThrow(/默认节点不存在/);
  });
});
