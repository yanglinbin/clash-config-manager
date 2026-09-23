/** 对齐 Python re.escape 的字符集合（3.7+ 仅转义正则特殊字符与空白）。 */
const SPECIAL_CHARS = new Set(
  "()[]{}?*+-|^$\\.&~# \t\n\r\v\f".split(""),
);

export function escapeRegex(text: string): string {
  let out = "";
  for (const ch of text) {
    out += SPECIAL_CHARS.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}
