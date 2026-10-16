import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { ConfigManager } from "../services/configManager.js";
import type { GitPoller } from "../services/gitPoller.js";
import { createLogger } from "../utils/log.js";
import { PUBLIC_DIR, OUTPUT_FILE } from "../utils/paths.js";
import { isoSeconds } from "../utils/time.js";

export function buildApp(configManager: ConfigManager, gitPoller?: GitPoller): FastifyInstance {
  const log = createLogger("app.log");
  const app = Fastify({ logger: false });

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

    info.last_error =
      configManager.lastErrors.length > 0 ? configManager.lastErrors.join("; ") : null;

    if (gitPoller) info.git = gitPoller.status();

    return info;
  });

  app.post("/update-config", async () => {
    try {
      log.info("收到更新请求");
      const { ok, errors } = await configManager.regenerateConfig();
      if (ok) {
        return {
          status: "success",
          message: "Config updated successfully",
          timestamp: isoSeconds(),
        };
      }
      return {
        status: "error",
        message: "Config update failed",
        errors,
        timestamp: isoSeconds(),
      };
    } catch (err) {
      log.error(`更新异常: ${(err as Error).message}`);
      return { error: "Internal server error" };
    }
  });

  app.get("/clash_profile.yaml", (request, reply) => {
    if (!fs.existsSync(OUTPUT_FILE)) {
      return reply.code(404).send({ error: "配置文件不存在" });
    }
    const stat = fs.statSync(OUTPUT_FILE);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    reply.header("ETag", etag);
    reply.header("Cache-Control", "no-cache");
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.type("text/yaml; charset=utf-8");
    return fs.readFileSync(OUTPUT_FILE, "utf-8");
  });

  return app;
}
