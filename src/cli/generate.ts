#!/usr/bin/env node
/**
 * Clash 配置生成器 - 命令行入口
 *
 * 用法:
 *   node dist/cli/generate.js
 */

import { pathToFileURL } from "node:url";

import { ClashConfigGenerator } from "../clash/generator.js";
import { createLogger } from "../utils/log.js";

async function main(): Promise<void> {
  const log = createLogger("clash_generator.log");
  try {
    const generator = new ClashConfigGenerator(undefined, log);
    const success = await generator.run();
    process.exit(success ? 0 : 1);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
