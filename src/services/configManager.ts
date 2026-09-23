import fs from "node:fs";

import { loadIni } from "../clash/config.js";
import { ClashConfigGenerator } from "../clash/generator.js";
import { getInt } from "../utils/ini.js";
import { createLogger, type Logger } from "../utils/log.js";
import {
  CONFIG_INI,
  LAST_UPDATE_FILE,
  OUTPUT_DIR,
  OUTPUT_FILE,
  STATS_FILE,
} from "../utils/paths.js";
import { isoSeconds, parseIso } from "../utils/time.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 简单串行互斥：保证同一时刻只有一次生成。 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 统计信息（stats.json 结构）。 */
export interface Stats {
  generated_at: string;
  providers: number;
  providers_total: number;
  regions: number;
  groups: number;
  rules: number;
}

/**
 * 配置管理器：
 * 负责状态读取、生成触发、自动更新调度。
 */
export class ConfigManager {
  private readonly log: Logger;
  private readonly mutex = new Mutex();
  private schedulerStarted = false;
  private schedulerRunning = false;

  lastUpdate: Date | null;

  constructor(
    readonly configFile: string = CONFIG_INI,
    log: Logger = createLogger("app.log"),
  ) {
    this.log = log;
    this.loadConfig();
    this.lastUpdate = this.readLastUpdate();
  }

  /** 读取自动更新间隔所需的 [server] 配置。 */
  loadConfig(): void {
    if (fs.existsSync(this.configFile)) {
      this.log.info(`已加载配置文件: ${this.configFile}`);
    } else {
      this.log.warn(`配置文件 ${this.configFile} 不存在`);
    }
  }

  private readIni() {
    if (!fs.existsSync(this.configFile)) return null;
    return loadIni(this.configFile);
  }

  /** 从磁盘读取上次更新时间（重启后不丢失）。 */
  private readLastUpdate(): Date | null {
    try {
      if (fs.existsSync(LAST_UPDATE_FILE)) {
        const text = fs.readFileSync(LAST_UPDATE_FILE, "utf-8").trim();
        if (text) {
          const parsed = parseIso(text);
          if (parsed) return parsed;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(OUTPUT_FILE)) {
        return fs.statSync(OUTPUT_FILE).mtime;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private writeLastUpdate(time: Date): void {
    try {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(LAST_UPDATE_FILE, isoSeconds(time), "utf-8");
    } catch (err) {
      this.log.warn(`写入 last_update 失败: ${(err as Error).message}`);
    }
  }

  /** 自动更新间隔（秒），来自 [server] update_interval；0 或负值表示禁用。 */
  getUpdateInterval(): number {
    const ini = this.readIni();
    if (!ini) return 3600;
    try {
      return getInt(ini, "server", "update_interval", 3600);
    } catch {
      this.log.warn("config.ini 中 update_interval 无效，自动更新已禁用");
      return 0;
    }
  }

  /** 重新生成配置（带互斥锁，防止并发覆盖）。 */
  regenerateConfig(): Promise<boolean> {
    return this.mutex.run(async () => {
      try {
        const generator = new ClashConfigGenerator(
          this.configFile,
          createLogger("clash_generator.log"),
        );
        const ok = await generator.run();
        if (ok) {
          this.lastUpdate = new Date();
          this.writeLastUpdate(this.lastUpdate);
          this.log.info("配置文件重新生成成功");
          return true;
        }
        this.log.error("配置文件生成失败");
        return false;
      } catch (err) {
        this.log.error(`生成配置异常: ${(err as Error).message}`);
        return false;
      }
    });
  }

  /** 启动自动更新调度（幂等）。 */
  startScheduler(): void {
    if (this.schedulerStarted) return;
    const interval = this.getUpdateInterval();
    if (interval <= 0) {
      this.log.info("自动更新未启用（update_interval <= 0）");
      return;
    }

    this.schedulerStarted = true;
    this.schedulerRunning = true;
    void this.schedulerLoop();
    this.log.info(`自动更新调度已启动，间隔 ${interval} 秒`);

    if (!fs.existsSync(OUTPUT_FILE)) {
      void this.regenerateConfig();
    }
  }

  private async schedulerLoop(): Promise<void> {
    while (this.schedulerRunning) {
      const interval = this.getUpdateInterval();
      if (interval <= 0) {
        this.log.info("update_interval <= 0，自动更新调度退出");
        break;
      }
      await sleep(interval * 1000);
      if (!this.schedulerRunning) break;
      this.loadConfig();
      try {
        await this.regenerateConfig();
      } catch (err) {
        this.log.error(`定时更新异常: ${(err as Error).message}`);
      }
    }
  }

  stopScheduler(): void {
    this.schedulerRunning = false;
  }

  /** 读取生成器输出的统计信息。 */
  readStats(): Stats | null {
    try {
      if (fs.existsSync(STATS_FILE)) {
        return JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) as Stats;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}
