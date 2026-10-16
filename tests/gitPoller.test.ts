import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigManager } from "../src/services/configManager.js";
import {
  GitPoller,
  loadGitConfig,
  type GitConfig,
  type GitResult,
  type GitRunner,
} from "../src/services/gitPoller.js";
import { type Logger } from "../src/utils/log.js";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  close() {},
};

const tempDirs: string[] = [];

function makeWorkspace({
  git = true,
  rules = true,
}: { git?: boolean; rules?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitpoll-"));
  tempDirs.push(dir);
  if (git) fs.mkdirSync(path.join(dir, ".git"));
  if (rules) {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "rules.yaml"), "custom_rules: []\n");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function baseConfig(workspace: string, overrides: Partial<GitConfig> = {}): GitConfig {
  return {
    enable: true,
    repo: "https://example.com/repo.git",
    branch: "main",
    interval: 300,
    workspace,
    watchedPaths: ["config/rules.yaml"],
    ...overrides,
  };
}

function stubManager(): ConfigManager {
  return {
    rulesOverride: null,
    regenerateConfig: vi.fn(async () => ({ ok: true, errors: [] })),
  } as unknown as ConfigManager;
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

function makeRunner(handler: (args: string[]) => GitResult): {
  runGit: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGit: GitRunner = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { runGit, calls };
}

describe("GitPoller", () => {
  it("未启用时不执行任何 git 命令", async () => {
    const manager = stubManager();
    const { runGit, calls } = makeRunner(() => {
      throw new Error("should not run");
    });
    const poller = new GitPoller(
      baseConfig(makeWorkspace(), { enable: false }),
      manager,
      silentLogger,
      runGit,
    );

    await poller.pollOnce();
    expect(calls).toHaveLength(0);
    expect(manager.regenerateConfig).not.toHaveBeenCalled();
  });

  it("远端未变化时不重新生成，并切换规则来源到工作区", async () => {
    const workspace = makeWorkspace();
    const manager = stubManager();
    const { runGit } = makeRunner((args) => {
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse") return ok("aaaa\n");
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const poller = new GitPoller(baseConfig(workspace), manager, silentLogger, runGit);
    await poller.pollOnce();

    expect(manager.regenerateConfig).not.toHaveBeenCalled();
    expect(poller.status().head).toBe("aaaa");
    expect(manager.rulesOverride).toBe(path.join(workspace, "config", "rules.yaml"));
  });

  it("涉及 rules.yaml 的变更会重置工作区并重新生成", async () => {
    const workspace = makeWorkspace();
    const manager = stubManager();
    const { runGit } = makeRunner((args) => {
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("aaaa\n");
      if (args[0] === "rev-parse") return ok("bbbb\n");
      if (args[0] === "diff") return ok("config/rules.yaml\n");
      if (args[0] === "reset") return ok();
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const poller = new GitPoller(baseConfig(workspace), manager, silentLogger, runGit);
    await poller.pollOnce();

    expect(manager.regenerateConfig).toHaveBeenCalledTimes(1);
    expect(poller.status().rules_changed).toBe(true);
    expect(poller.status().last_error).toBeNull();
  });

  it("不涉及规则文件的变更只同步、不重新生成", async () => {
    const workspace = makeWorkspace();
    const manager = stubManager();
    const { runGit } = makeRunner((args) => {
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("aaaa\n");
      if (args[0] === "rev-parse") return ok("bbbb\n");
      if (args[0] === "diff") return ok("README.md\n");
      if (args[0] === "reset") return ok();
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const poller = new GitPoller(baseConfig(workspace), manager, silentLogger, runGit);
    await poller.pollOnce();

    expect(manager.regenerateConfig).not.toHaveBeenCalled();
    expect(poller.status().rules_changed).toBe(false);
  });

  it("拉取失败时记录错误且不影响服务", async () => {
    const workspace = makeWorkspace();
    const manager = stubManager();
    const { runGit } = makeRunner((args) => {
      if (args[0] === "fetch") return { code: 128, stdout: "", stderr: "fatal: boom" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const poller = new GitPoller(baseConfig(workspace), manager, silentLogger, runGit);
    await poller.pollOnce();

    expect(manager.regenerateConfig).not.toHaveBeenCalled();
    expect(poller.status().last_error).toContain("git fetch 失败");
  });

  it("工作区不存在时先克隆", async () => {
    const workspace = makeWorkspace({ git: false });
    const manager = stubManager();
    const { runGit, calls } = makeRunner((args) => {
      if (args[0] === "clone") return ok();
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse") return ok("cccc\n");
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const poller = new GitPoller(baseConfig(workspace), manager, silentLogger, runGit);
    await poller.pollOnce();

    expect(calls[0][0]).toBe("clone");
    // 首次克隆会按仓库规则生成一次
    expect(manager.regenerateConfig).toHaveBeenCalledTimes(1);
    expect(manager.rulesOverride).toBe(path.join(workspace, "config", "rules.yaml"));
  });
});

describe("loadGitConfig", () => {
  function writeConfig(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitcfg-"));
    tempDirs.push(dir);
    const file = path.join(dir, "config.ini");
    fs.writeFileSync(file, content);
    return file;
  }

  it("读取 [git] 段", () => {
    const file = writeConfig(
      "[git]\nenable = true\nrepo = https://example.com/r.git\ninterval = 120\n",
    );
    const config = loadGitConfig(file);
    expect(config.enable).toBe(true);
    expect(config.repo).toBe("https://example.com/r.git");
    expect(config.interval).toBe(120);
    expect(config.watchedPaths).toEqual(["config/rules.yaml"]);
  });

  it("缺少 [git] 段时默认关闭", () => {
    const config = loadGitConfig(writeConfig("[clash]\nport = 7890\n"));
    expect(config.enable).toBe(false);
  });

  it("环境变量覆盖 enable/interval，空值忽略", () => {
    const file = writeConfig("[git]\nenable = false\nrepo = https://example.com/r.git\n");
    try {
      process.env.GIT_PULL_ENABLED = "";
      expect(loadGitConfig(file).enable).toBe(false);
      process.env.GIT_PULL_ENABLED = "true";
      expect(loadGitConfig(file).enable).toBe(true);
      process.env.GIT_INTERVAL = "15";
      expect(loadGitConfig(file).interval).toBe(15);
    } finally {
      delete process.env.GIT_PULL_ENABLED;
      delete process.env.GIT_INTERVAL;
    }
  });
});
