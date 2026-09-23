/** 时间格式化助手，对齐 Python datetime 的输出格式（本地时区）。 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 对齐 datetime.isoformat(timespec="seconds")：2026-09-23T20:09:54 */
export function isoSeconds(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 对齐 strftime("%Y-%m-%d %H:%M:%S")：2026-09-23 20:09:54 */
export function formatDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 解析 isoformat 字符串，失败返回 null（无时区按本地时间解析，与 Python 一致）。 */
export function parseIso(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
