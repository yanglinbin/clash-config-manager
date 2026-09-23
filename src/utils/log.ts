import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./paths.js";

type LevelName = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVEL_VALUE: Record<LevelName, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

function configuredLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return LEVEL_VALUE[raw as LevelName] ?? LEVEL_VALUE.INFO;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 与 Python logging 默认格式一致：2026-09-23 20:09:54,935 - INFO - msg */
function timestamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(
      d.getMilliseconds(),
      3,
    )}`
  );
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  return String(arg);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * 创建同时写入 logs/<fileName> 与控制台的日志器。
 * 级别由环境变量 LOG_LEVEL 控制（默认 INFO）。
 */
export function createLogger(fileName: string): Logger {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stream = fs.createWriteStream(path.join(LOG_DIR, fileName), {
    flags: "a",
    encoding: "utf-8",
  });

  const emit = (level: LevelName, args: unknown[]): void => {
    if (LEVEL_VALUE[level] < configuredLevel()) return;
    const line = `${timestamp()} - ${level} - ${args.map(formatArg).join(" ")}`;
    stream.write(`${line}\n`);
    if (level === "ERROR" || level === "WARNING") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };

  return {
    debug: (...args) => emit("DEBUG", args),
    info: (...args) => emit("INFO", args),
    warn: (...args) => emit("WARNING", args),
    error: (...args) => emit("ERROR", args),
  };
}
