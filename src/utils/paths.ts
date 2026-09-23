import path from "node:path";

/**
 * 项目根目录：默认取进程工作目录（容器内为 /app），可用环境变量 APP_ROOT 覆盖。
 * 服务、CLI 均需在项目根目录下运行。
 */
export const PROJECT_ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : process.cwd();

export const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const CONFIG_INI = path.join(CONFIG_DIR, "config.ini");
export const LOG_DIR = path.join(PROJECT_ROOT, "logs");
export const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
export const OUTPUT_FILE = path.join(OUTPUT_DIR, "clash_profile.yaml");
export const STATS_FILE = path.join(OUTPUT_DIR, "stats.json");
export const LAST_UPDATE_FILE = path.join(OUTPUT_DIR, "last_update.txt");
/** 静态资源目录（index.html / css / 编译后的 js），由 Fastify 对外托管 */
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
