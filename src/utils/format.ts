/** 与 Python repr(list[str]) 一致的格式化：['a', 'b'] */
export function pyList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}
