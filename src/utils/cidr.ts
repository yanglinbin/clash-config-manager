/**
 * 极简 CIDR 解析与关系判断（对齐 Python ipaddress 的非严格模式语义）。
 * 用 BigInt 表示地址，同时支持 IPv4 / IPv6。
 */
export interface Cidr {
  version: 4 | 6;
  /** 网络地址（已按前缀掩码） */
  start: bigint;
  /** 广播/末地址 */
  end: bigint;
  prefix: number;
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function parseIpv6(value: string): bigint | null {
  let text = value;
  if (text.includes(".")) {
    const idx = text.lastIndexOf(":");
    const v4 = parseIpv4(text.slice(idx + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, idx + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(
      v4 & 0xffffn
    ).toString(16)}`;
  }

  const sides = text.split("::");
  if (sides.length > 2) return null;
  const groupsOf = (s: string): string[] => (s ? s.split(":") : []);
  const left = groupsOf(sides[0]);
  const right = sides.length === 2 ? groupsOf(sides[1]) : [];

  let groups: string[];
  if (sides.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;

  let acc = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    acc = (acc << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return acc;
}

/** 解析 CIDR；非法返回 null。 */
export function parseCidr(input: string): Cidr | null {
  const slash = input.indexOf("/");
  const addrStr = slash === -1 ? input : input.slice(0, slash);
  const prefixStr = slash === -1 ? "" : input.slice(slash + 1);

  const isV6 = addrStr.includes(":");
  const version: 4 | 6 = isV6 ? 6 : 4;
  const bits = isV6 ? 128 : 32;

  const value = isV6 ? parseIpv6(addrStr) : parseIpv4(addrStr);
  if (value === null) return null;

  let prefix = bits;
  if (prefixStr !== "") {
    if (!/^\d+$/.test(prefixStr)) return null;
    prefix = Number(prefixStr);
    if (prefix > bits) return null;
  }

  const hostBits = BigInt(bits - prefix);
  const mask = ((1n << BigInt(prefix)) - 1n) << hostBits;
  const all = (1n << BigInt(bits)) - 1n;
  const network = value & mask;
  const end = network | (all ^ mask);

  return { version, start: network, end, prefix };
}

/** a 是否完全被 b 包含（含相等）。 */
export function isSubnetOf(a: Cidr, b: Cidr): boolean {
  return a.version === b.version && a.start >= b.start && a.end <= b.end;
}

/** 两者是否重叠。 */
export function overlaps(a: Cidr, b: Cidr): boolean {
  return a.version === b.version && a.start <= b.end && b.start <= a.end;
}
