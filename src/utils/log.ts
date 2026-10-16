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

/** 单文件日志轮转阈值（字节），可用 LOG_MAX_BYTES 覆盖，默认 5MB。 */
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

function configuredLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return LEVEL_VALUE[raw as LevelName] ?? LEVEL_VALUE.INFO;
}

function configuredMaxBytes(): number {
  const raw = process.env.LOG_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_LOG_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOG_BYTES;
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
  /** 关闭底层文件流（进程退出时调用）。 */
  close(): void;
}

/** 同名日志器全局唯一，避免每次调用都新开文件流导致 FD 泄漏。 */
const loggers = new Map<string, Logger>();

/**
 * 创建（或复用）同时写入 logs/<fileName> 与控制台的日志器。
 * 级别由环境变量 LOG_LEVEL 控制（默认 INFO）；
 * 单文件超过 LOG_MAX_BYTES（默认 5MB）时轮转为 `<file>.1`。
 */
export function createLogger(fileName: string): Logger {
  const existing = loggers.get(fileName);
  if (existing) return existing;
  const logger = createFileLogger(fileName);
  loggers.set(fileName, logger);
  return logger;
}

/** 关闭所有日志器（进程退出时调用，确保日志落盘）。 */
export function closeAllLoggers(): void {
  for (const logger of loggers.values()) logger.close();
  loggers.clear();
}

function createFileLogger(fileName: string): Logger {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const filePath = path.join(LOG_DIR, fileName);
  const maxBytes = configuredMaxBytes();

  const openStream = (): fs.WriteStream =>
    fs.createWriteStream(filePath, { flags: "a", encoding: "utf-8" });

  let stream = openStream();
  let bytesWritten = 0;
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }

  /** 超过阈值时把当前文件轮转为 `<file>.1` 并重开。 */
  const rotate = (): void => {
    try {
      stream.end();
      const rotated = `${filePath}.1`;
      fs.rmSync(rotated, { force: true });
      fs.renameSync(filePath, rotated);
    } catch {
      /* 轮转失败时继续写原文件 */
    }
    stream = openStream();
    bytesWritten = 0;
  };

  const emit = (level: LevelName, args: unknown[]): void => {
    if (LEVEL_VALUE[level] < configuredLevel()) return;
    const line = `${timestamp()} - ${level} - ${args.map(formatArg).join(" ")}`;
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (bytesWritten + lineBytes > maxBytes) rotate();
    stream.write(`${line}\n`);
    bytesWritten += lineBytes;
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
    close: () => {
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    },
  };
}
