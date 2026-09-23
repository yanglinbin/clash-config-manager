#!/usr/bin/env node
/**
 * Clash Config Manager 服务入口。
 */

import { buildApp } from "./server/app.js";
import { ConfigManager } from "./services/configManager.js";
import { createLogger } from "./utils/log.js";
import { PUBLIC_DIR } from "./utils/paths.js";

const log = createLogger("app.log");

const configManager = new ConfigManager(undefined, log);
// 自动更新调度在服务启动时开启（幂等）
configManager.startScheduler();

const app = buildApp(configManager);

const port = Number.parseInt(process.env.APP_PORT ?? "5000", 10);
const host = "0.0.0.0";
const portSource = process.env.APP_PORT ? "环境变量" : "默认值";

log.info(`启动 Web 服务器: ${host}:${port} (端口来源: ${portSource})`);
log.info(`静态资源目录: ${PUBLIC_DIR}`);

app
  .listen({ host, port })
  .catch((err) => {
    log.error(`服务启动失败: ${(err as Error).message}`);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    configManager.stopScheduler();
    void app.close().finally(() => process.exit(0));
  });
}
