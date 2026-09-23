import fs from "node:fs";

import { ClashConfigGenerator } from "../clash/generator.js";
import { createLogger, type Logger } from "../utils/log.js";
import {
  CONFIG_INI,
  LAST_UPDATE_FILE,
  OUTPUT_DIR,
  OUTPUT_FILE,
  STATS_FILE,
} from "../utils/paths.js";
import { isoSeconds, parseIso } from "../utils/time.js";

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
 * 配置管理器：负责状态读取、生成触发（手动 / Webhook）。
 *
 * 更新触发方式：页面「更新配置」、`POST /update-config`、GitHub Webhook，
 * 以及启动时若输出配置尚不存在则生成一次。不再有定时自动更新。
 */
export class ConfigManager {
  private readonly log: Logger;
  private readonly mutex = new Mutex();

  lastUpdate: Date | null;

  constructor(
    readonly configFile: string = CONFIG_INI,
    log: Logger = createLogger("app.log"),
  ) {
    this.log = log;
    this.loadConfig();
    this.lastUpdate = this.readLastUpdate();
  }

  loadConfig(): void {
    if (fs.existsSync(this.configFile)) {
      this.log.info(`已加载配置文件: ${this.configFile}`);
    } else {
      this.log.warn(`配置文件 ${this.configFile} 不存在`);
    }
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

  /** 启动时若输出配置尚不存在，后台生成一次（不阻塞启动）。 */
  ensureInitialConfig(): void {
    if (fs.existsSync(OUTPUT_FILE)) return;
    this.log.info("输出配置不存在，启动时生成一次");
    void this.regenerateConfig();
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
