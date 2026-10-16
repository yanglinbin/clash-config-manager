import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getBool, getInt, getStr, hasSection, parseIni, type IniData } from "../utils/ini.js";
import type { Logger } from "../utils/log.js";
import { PROJECT_ROOT } from "../utils/paths.js";
import { isoSeconds } from "../utils/time.js";
import type { ConfigManager } from "./configManager.js";

const execFileAsync = promisify(execFile);

/** [git] 段解析后的配置。 */
export interface GitConfig {
  enable: boolean;
  repo: string;
  branch: string;
  /** 轮询间隔（秒） */
  interval: number;
  /** 容器/宿主机内的克隆目录 */
  workspace: string;
  /** 变更后触发重新生成的文件列表 */
  watchedPaths: string[];
}

/** 对外暴露的轮询状态（/status.git）。 */
export interface GitStatus {
  enabled: boolean;
  last_pull_at: string | null;
  head: string | null;
  rules_changed: boolean;
  last_error: string | null;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const DEFAULT_WATCHED_PATHS = ["config/rules.yaml"];
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 10;

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function resolveWorkspace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return path.join(PROJECT_ROOT, "repo");
  return path.isAbsolute(trimmed) ? trimmed : path.join(PROJECT_ROOT, trimmed);
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** 环境变量覆盖（便于运维，不改 config.ini）。 */
function applyEnv(config: GitConfig): GitConfig {
  const enabled = process.env.GIT_PULL_ENABLED;
  if (enabled !== undefined && enabled.trim() !== "") {
    config.enable = TRUTHY.has(enabled.trim().toLowerCase());
  }
  if (process.env.GIT_REPO) config.repo = process.env.GIT_REPO.trim();
  if (process.env.GIT_BRANCH) config.branch = process.env.GIT_BRANCH.trim();
  if (process.env.GIT_WORKSPACE) config.workspace = resolveWorkspace(process.env.GIT_WORKSPACE);
  if (process.env.GIT_INTERVAL) {
    const parsed = Number.parseInt(process.env.GIT_INTERVAL, 10);
    if (Number.isFinite(parsed) && parsed > 0) config.interval = parsed;
  }
  return config;
}

/** 从 config.ini 读取 [git] 段；缺失或非法时返回「未启用」的默认配置。 */
export function loadGitConfig(iniPath: string): GitConfig {
  const config: GitConfig = {
    enable: false,
    repo: "",
    branch: "main",
    interval: DEFAULT_INTERVAL_SECONDS,
    workspace: path.join(PROJECT_ROOT, "repo"),
    watchedPaths: [...DEFAULT_WATCHED_PATHS],
  };

  if (!fs.existsSync(iniPath)) return applyEnv(config);

  let ini: IniData;
  try {
    ini = parseIni(fs.readFileSync(iniPath, "utf-8"));
  } catch {
    return applyEnv(config);
  }
  if (!hasSection(ini, "git")) return applyEnv(config);

  try {
    config.enable = getBool(ini, "git", "enable", false);
    config.repo = getStr(ini, "git", "repo").trim();
    const branch = getStr(ini, "git", "branch", "main").trim();
    config.branch = branch || "main";
    config.interval = getInt(ini, "git", "interval", DEFAULT_INTERVAL_SECONDS);
    config.workspace = resolveWorkspace(getStr(ini, "git", "workspace"));
    const watched = parseList(getStr(ini, "git", "watched_paths"));
    if (watched.length > 0) config.watchedPaths = watched;
  } catch {
    // [git] 段取值非法时保持「未启用」的默认配置
    return applyEnv(config);
  }

  const withEnv = applyEnv(config);
  withEnv.interval = Math.max(MIN_INTERVAL_SECONDS, withEnv.interval);
  return withEnv;
}

async function defaultRunGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 60_000,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const error = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr || error.message,
    };
  }
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-1)[0] ?? text.trim();
}

/**
 * 方案 B：应用内定时轮询 git 仓库。
 *
 * 服务器**主动出站**拉取，检测 `watchedPaths` 变化后触发 `ConfigManager.regenerateConfig()`；
 * 拉取/克隆失败时不影响服务，回退到挂载的 `config/rules.yaml`。
 */
export class GitPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly state: GitStatus;

  constructor(
    private readonly config: GitConfig,
    private readonly manager: ConfigManager,
    private readonly log: Logger,
    private readonly runGit: GitRunner = defaultRunGit,
  ) {
    this.state = {
      enabled: config.enable,
      last_pull_at: null,
      head: null,
      rules_changed: false,
      last_error: null,
    };
  }

  status(): GitStatus {
    return { ...this.state };
  }

  /** 启动轮询（未启用或未配置 repo 时安全返回）。 */
  start(): void {
    if (!this.config.enable) {
      this.log.info("git 轮询未启用（[git] enable=false）");
      return;
    }
    if (!this.config.repo) {
      this.state.last_error = "未配置 [git] repo";
      this.log.warn("git 轮询已启用，但未配置 [git] repo，跳过");
      return;
    }
    this.log.info(
      `git 轮询已启动: ${this.config.repo} (${this.config.branch}) 每 ${this.config.interval}s`,
    );
    void this.pollOnce();
    this.schedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedule());
    }, this.config.interval * 1000);
    this.timer.unref?.();
  }

  /** 执行一次同步与变更检测（可独立调用，便于测试）。 */
  async pollOnce(): Promise<void> {
    if (!this.config.enable || this.running) return;
    this.running = true;
    try {
      await this.sync();
    } catch (err) {
      this.state.last_error = (err as Error).message;
      this.log.error(`git 轮询失败: ${this.state.last_error}`);
    } finally {
      this.running = false;
      this.state.last_pull_at = isoSeconds();
    }
  }

  private workspaceRulesPath(workspace: string): string | null {
    const candidate = path.join(workspace, "config", "rules.yaml");
    return fs.existsSync(candidate) ? candidate : null;
  }

  private async sync(): Promise<void> {
    const { workspace, branch, repo, watchedPaths } = this.config;
    this.state.rules_changed = false;

    let clonedNow = false;
    if (!fs.existsSync(path.join(workspace, ".git"))) {
      fs.mkdirSync(path.dirname(workspace), { recursive: true });
      this.log.info(`克隆仓库: ${repo} -> ${workspace}`);
      const cloned = await this.runGit(
        ["clone", "--depth", "1", "--branch", branch, repo, workspace],
        path.dirname(workspace),
      );
      if (cloned.code !== 0) throw new Error(`git clone 失败: ${tail(cloned.stderr)}`);
      clonedNow = true;
    }

    const fetched = await this.runGit(["fetch", "--depth", "1", "origin", branch], workspace);
    if (fetched.code !== 0) throw new Error(`git fetch 失败: ${tail(fetched.stderr)}`);

    const local = (await this.runGit(["rev-parse", "HEAD"], workspace)).stdout.trim();
    const remote = (await this.runGit(["rev-parse", `origin/${branch}`], workspace)).stdout.trim();
    this.state.head = remote || local;

    // 工作区就绪后，把规则来源切换到仓库中的 rules.yaml（失败时由 generator 回退到挂载文件）
    this.manager.rulesOverride = this.workspaceRulesPath(workspace);
    this.manager.gitHead = this.state.head;

    if (!remote || remote === local) {
      if (clonedNow) {
        // 首次克隆：按仓库规则生成一次，确保与服务启动时的输出一致
        this.log.info("首次克隆完成，按仓库规则重新生成配置");
        await this.regenerate();
      }
      return;
    }

    const diff = await this.runGit(["diff", "--name-only", local, remote], workspace);
    const changed = diff.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const updated = await this.runGit(["reset", "--hard", `origin/${branch}`], workspace);
    if (updated.code !== 0) throw new Error(`git reset 失败: ${tail(updated.stderr)}`);

    const touched = changed.filter((file) => watchedPaths.includes(file));
    this.state.rules_changed = touched.length > 0;

    if (touched.length === 0) {
      this.log.info(`git 已更新到 ${remote.slice(0, 8)}，但未涉及规则文件，跳过重新生成`);
      return;
    }

    this.log.info(`检测到规则变更（${touched.join(", ")}），重新生成配置`);
    await this.regenerate();
  }

  /** 触发一次重新生成；失败时抛出（由 pollOnce 记录到 last_error）。 */
  private async regenerate(): Promise<void> {
    const { ok, errors } = await this.manager.regenerateConfig();
    if (!ok) throw new Error(`配置生成失败: ${errors.join("; ")}`);
    this.state.last_error = null;
  }
}
