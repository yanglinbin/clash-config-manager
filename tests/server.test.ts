import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server/app.js";
import type { ConfigManager } from "../src/services/configManager.js";

function stubManager(): ConfigManager {
  return {
    lastUpdate: null,
    lastErrors: [],
    readStats: () => null,
    regenerateConfig: vi.fn(async () => ({ ok: true, errors: [] })),
  } as unknown as ConfigManager;
}

describe("路由", () => {
  it("/status 返回关键字段", async () => {
    const app = buildApp(stubManager());
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.server).toBe("Clash Config Manager");
    expect(data).toHaveProperty("config_file_exists");
    await app.close();
  });

  it("/update-config 触发重新生成", async () => {
    const manager = stubManager();
    const app = buildApp(manager);
    const res = await app.inject({ method: "POST", url: "/update-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("success");
    expect(manager.regenerateConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("/update-config 失败时回传错误原因", async () => {
    const manager = {
      lastUpdate: null,
      lastErrors: [],
      readStats: () => null,
      regenerateConfig: vi.fn(async () => ({ ok: false, errors: ["boom"] })),
    } as unknown as ConfigManager;
    const app = buildApp(manager);
    const res = await app.inject({ method: "POST", url: "/update-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("error");
    expect(res.json().errors).toEqual(["boom"]);
    await app.close();
  });

  it("/status 暴露 last_error", async () => {
    const manager = {
      lastUpdate: null,
      lastErrors: ["bad config"],
      readStats: () => null,
      regenerateConfig: vi.fn(),
    } as unknown as ConfigManager;
    const app = buildApp(manager);
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.json().last_error).toBe("bad config");
    await app.close();
  });

  it("/clash_profile.yaml 支持 ETag / 304", async () => {
    const file = path.join(process.cwd(), "output", "clash_profile.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      fs.writeFileSync(file, "port: 7890\n");
      const app = buildApp(stubManager());

      const first = await app.inject({ method: "GET", url: "/clash_profile.yaml" });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();

      const second = await app.inject({
        method: "GET",
        url: "/clash_profile.yaml",
        headers: { "if-none-match": etag },
      });
      expect(second.statusCode).toBe(304);
      await app.close();
    } finally {
      if (backup) fs.writeFileSync(file, backup);
      else fs.rmSync(file, { force: true });
    }
  });
});
