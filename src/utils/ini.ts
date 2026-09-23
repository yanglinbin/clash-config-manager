/**
 * 轻量 INI 解析器，行为对齐 Python configparser（RawConfigParser）：
 * - 保留键名大小写（optionxform = str）
 * - 仅整行注释（# / ;），默认不识别行内注释
 * - 键值分隔符取行内首个 `=` 或 `:`
 * - 值去首尾空白
 */
export type IniData = Record<string, Record<string, string>>;

export function parseIni(text: string): IniData {
  const data: IniData = {};
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = /^\[(.*)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!(section in data)) data[section] = {};
      continue;
    }

    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    let idx: number;
    if (eq === -1) idx = colon;
    else if (colon === -1) idx = eq;
    else idx = Math.min(eq, colon);
    if (idx === -1 || !section) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    data[section][key] = value;
  }

  return data;
}

export function hasSection(ini: IniData, section: string): boolean {
  return Object.prototype.hasOwnProperty.call(ini, section);
}

/** 取字符串值；缺失返回 fallback。 */
export function getStr(
  ini: IniData,
  section: string,
  key: string,
  fallback = "",
): string {
  const sec = ini[section];
  if (!sec || !(key in sec)) return fallback;
  return sec[key];
}

const TRUE_VALUES = new Set(["1", "yes", "true", "on"]);
const FALSE_VALUES = new Set(["0", "no", "false", "off"]);

/** 取整数；缺失返回 fallback，值非法抛错（对齐 configparser.getint）。 */
export function getInt(
  ini: IniData,
  section: string,
  key: string,
  fallback: number,
): number {
  const sec = ini[section];
  if (!sec || !(key in sec)) return fallback;
  const raw = sec[key];
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new Error(`invalid int value: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw.trim(), 10);
}

/** 取布尔；缺失返回 fallback，值非法抛错（对齐 configparser.getboolean）。 */
export function getBool(
  ini: IniData,
  section: string,
  key: string,
  fallback: boolean,
): boolean {
  const sec = ini[section];
  if (!sec || !(key in sec)) return fallback;
  const raw = sec[key].trim().toLowerCase();
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  throw new Error(`invalid boolean value: ${JSON.stringify(raw)}`);
}
