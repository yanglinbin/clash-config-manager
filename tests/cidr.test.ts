import { describe, expect, it } from "vitest";

import { isSubnetOf, overlaps, parseCidr } from "../src/utils/cidr.js";

describe("parseCidr / 网段关系", () => {
  it("解析 IPv4 与 IPv6", () => {
    const v4 = parseCidr("192.168.1.0/24");
    expect(v4).not.toBeNull();
    expect(v4!.version).toBe(4);
    expect(v4!.prefix).toBe(24);

    const v6 = parseCidr("2001:db8::/32");
    expect(v6).not.toBeNull();
    expect(v6!.version).toBe(6);

    // 无前缀按主机位全 1 处理
    expect(parseCidr("10.0.0.1")!.prefix).toBe(32);
  });

  it("非法输入返回 null", () => {
    expect(parseCidr("999.1.1.0/24")).toBeNull();
    expect(parseCidr("192.168.1.0/33")).toBeNull();
    expect(parseCidr("not-an-ip")).toBeNull();
  });

  it("网络地址按掩码归一", () => {
    const cidr = parseCidr("192.168.1.200/24")!;
    expect(cidr.start).toBe(parseCidr("192.168.1.0/24")!.start);
    expect(cidr.end).toBe(parseCidr("192.168.1.255/24")!.end);
  });

  it("包含与重叠判断", () => {
    const big = parseCidr("10.0.0.0/8")!;
    const small = parseCidr("10.1.0.0/16")!;
    const other = parseCidr("11.0.0.0/8")!;
    const v6 = parseCidr("2001:db8::/32")!;

    expect(isSubnetOf(small, big)).toBe(true);
    expect(isSubnetOf(big, small)).toBe(false);
    expect(overlaps(small, big)).toBe(true);
    expect(overlaps(big, other)).toBe(false);
    expect(overlaps(big, v6)).toBe(false);
    expect(isSubnetOf(big, v6)).toBe(false);
  });
});
