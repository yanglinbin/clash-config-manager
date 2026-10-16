import fs from "node:fs";

import { ClashConfigGenerator } from "../clash/generator.js";
import { writeFileAtomic } from "../utils/atomic.js";
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
 * 配置管理器：负责状态读取、生成触发。
 *
 * 更新触发方式：页面「更新配置」、`POST /update-config`，
 * 以及启动时若输出配置尚不存在则生成一次。不再有定时自动更新。
 */
export class ConfigManager {
  private readonly log: Logger;
  private readonly generatorLog: Logger;
  private readonly mutex = new Mutex();

  lastUpdate: Date | null;

  /** 最近一次生成失败的原因（成功后清空）。 */
  lastErrors: string[] = [];

  /** 规则文件覆盖路径（方案 B：git 工作区中的 rules.yaml）；为空则用 config.ini 配置的路径。 */
  rulesOverride: string | null = null;

  /** 当前 git 工作区 HEAD（写入 stats.json，供排查）。 */
  gitHead: string | null = null;

  constructor(
    readonly configFile: string = CONFIG_INI,
    log: Logger = createLogger("app.log"),
  ) {
    this.log = log;
    this.generatorLog = createLogger("clash_generator.log");
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
  regenerateConfig(): Promise<{ ok: boolean; errors: string[] }> {
    return this.mutex.run(async () => {
      try {
        const generator = new ClashConfigGenerator(
          this.configFile,
          this.generatorLog,
          this.rulesOverride ?? undefined,
          this.gitHead,
        );
        const { ok, errors } = await generator.run();
        if (ok) {
          this.lastUpdate = new Date();
          this.writeLastUpdate(this.lastUpdate);
          this.lastErrors = [];
          this.log.info("配置文件重新生成成功");
          return { ok: true, errors: [] };
        }
        this.lastErrors = errors;
        this.writeStatsError(errors.join("; "));
        this.log.error(`配置文件生成失败${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
        return { ok: false, errors };
      } catch (err) {
        const message = (err as Error).message;
        this.lastErrors = [message];
        this.writeStatsError(message);
        this.log.error(`生成配置异常: ${message}`);
        return { ok: false, errors: [message] };
      }
    });
  }

  /** 启动时若输出配置尚不存在，后台生成一次（不阻塞启动）。 */
  ensureInitialConfig(): void {
    if (fs.existsSync(OUTPUT_FILE)) return;
    this.log.info("输出配置不存在，启动时生成一次");
    void this.regenerateConfig();
  }

  /** 生成失败时把错误原因合并进 stats.json（文件存在才更新）。 */
  private writeStatsError(message: string): void {
    try {
      if (!fs.existsSync(STATS_FILE)) return;
      const stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) as Record<string, unknown>;
      stats.last_error = message;
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch {
      /* ignore */
    }
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
