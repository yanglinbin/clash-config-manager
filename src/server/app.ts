import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { ConfigManager } from "../services/configManager.js";
import { createLogger } from "../utils/log.js";
import { PUBLIC_DIR, OUTPUT_FILE } from "../utils/paths.js";
import { isoSeconds } from "../utils/time.js";

/** 仅当 push 涉及这些路径时才触发重新生成 */
const WEBHOOK_WATCHED_PATHS = new Set(["config/rules.yaml"]);

function webhookSecret(): string {
  return process.env.GITHUB_WEBHOOK_SECRET ?? "";
}

/** 校验 GitHub 的 X-Hub-Signature-256（HMAC-SHA256），恒定时间比较。 */
function verifyGithubSignature(
  secret: string,
  body: Buffer,
  signature: string | undefined,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从 push payload 的 commits 中收集变更文件路径；无法判定时返回 null。 */
function collectChangedPaths(payload: Record<string, unknown>): Set<string> | null {
  const paths = new Set<string>();
  const commits = payload["commits"];
  if (Array.isArray(commits)) {
    for (const commit of commits) {
      if (!commit || typeof commit !== "object") continue;
      const record = commit as Record<string, unknown>;
      for (const key of ["added", "modified", "removed"]) {
        const list = record[key];
        if (Array.isArray(list)) for (const p of list) paths.add(String(p));
      }
    }
  }
  return paths.size > 0 ? paths : null;
}

export function buildApp(configManager: ConfigManager): FastifyInstance {
  const log = createLogger("app.log");
  const app = Fastify({ logger: false });

  // 保留原始请求体用于 HMAC 校验，同时正常解析 JSON
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
      const buf = body as Buffer;
      if (buf.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(buf.toString("utf-8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/static/",
  });

  app.get("/", (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return fs.createReadStream(path.join(PUBLIC_DIR, "index.html"));
  });

  app.get("/status", () => {
    const info: Record<string, unknown> = {
      server: "Clash Config Manager",
      status: "running",
      timestamp: isoSeconds(),
      last_update: configManager.lastUpdate ? isoSeconds(configManager.lastUpdate) : null,
      config_file: "output/clash_profile.yaml",
    };

    const exists = fs.existsSync(OUTPUT_FILE);
    info.config_file_exists = exists;
    if (exists) {
      const stat = fs.statSync(OUTPUT_FILE);
      info.config_file_size = stat.size;
      info.config_file_modified = isoSeconds(stat.mtime);
    }

    const stats = configManager.readStats();
    if (stats) info.stats = stats;

    info.webhook_enabled = webhookSecret().length > 0;

    return info;
  });

  app.post("/update-config", async () => {
    try {
      log.info("收到更新请求");
      if (await configManager.regenerateConfig()) {
        return {
          status: "success",
          message: "Config updated successfully",
          timestamp: isoSeconds(),
        };
      }
      return {
        status: "error",
        message: "Config update failed",
        timestamp: isoSeconds(),
      };
    } catch (err) {
      log.error(`更新异常: ${(err as Error).message}`);
      return { error: "Internal server error" };
    }
  });

  app.get("/clash_profile.yaml", (_request, reply) => {
    if (!fs.existsSync(OUTPUT_FILE)) {
      return reply.code(404).send({ error: "配置文件不存在" });
    }
    reply.type("text/yaml; charset=utf-8");
    return fs.readFileSync(OUTPUT_FILE, "utf-8");
  });

  app.post("/webhook/github", (request, reply) => {
    const secret = webhookSecret();
    if (!secret) {
      log.warn("收到 webhook 请求，但未配置 GITHUB_WEBHOOK_SECRET");
      return reply.code(503).send({ error: "Webhook 未配置" });
    }

    const body =
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(request.body ?? {}), "utf-8");
    const signature = request.headers["x-hub-signature-256"];

    if (!verifyGithubSignature(secret, body, Array.isArray(signature) ? signature[0] : signature)) {
      log.warn("webhook 签名校验失败，已拒绝");
      return reply.code(401).send({ error: "签名校验失败" });
    }

    const event = String(request.headers["x-github-event"] ?? "");
    if (event === "ping") return { status: "pong" };
    if (event !== "push") {
      return reply.code(202).send({ status: "ignored", reason: `未处理的事件: ${event}` });
    }

    const payload = (request.body ?? {}) as Record<string, unknown>;
    const changed = collectChangedPaths(payload);
    if (changed && ![...changed].some((p) => WEBHOOK_WATCHED_PATHS.has(p))) {
      return reply.code(202).send({
        status: "ignored",
        reason: "未涉及受监控路径",
        watched: [...WEBHOOK_WATCHED_PATHS].sort(),
      });
    }

    // 异步触发：regenerateConfig 内部有锁，与定时任务/手动更新互斥
    void configManager.regenerateConfig();
    log.info("webhook 触发配置重新生成");
    return reply.code(202).send({ status: "accepted", message: "配置重新生成已触发" });
  });

  return app;
}
