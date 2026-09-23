import fs from "node:fs";
import path from "node:path";

/** 原子写入：先写临时文件，再 rename 覆盖，避免读到半个文件。 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}
