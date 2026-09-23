import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server/app.js";
import type { ConfigManager } from "../src/services/configManager.js";

const SECRET = "testsecret";

function stubManager(): ConfigManager {
  return {
    getUpdateInterval: () => 3600,
    lastUpdate: null,
    readStats: () => null,
    regenerateConfig: vi.fn(async () => true),
  } as unknown as ConfigManager;
}

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

describe("webhook / 路由", () => {
  it("未配置密钥返回 503；ping 与签名校验", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    let app = buildApp(stubManager());
    let res = await app.inject({ method: "POST", url: "/webhook/github", payload: {} });
    expect(res.statusCode).toBe(503);
    await app.close();

    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    app = buildApp(stubManager());

    res = await app.inject({
      method: "POST",
      url: "/webhook/github",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": "sha256=bad" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);

    const body = JSON.stringify({ zen: "hi" });
    res = await app.inject({
      method: "POST",
      url: "/webhook/github",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "pong" });

    await app.close();
  });

  it("push 未涉及 rules.yaml 时忽略，涉及则触发", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const manager = stubManager();
    const app = buildApp(manager);

    const other = JSON.stringify({ commits: [{ modified: ["README.md"] }] });
    let res = await app.inject({
      method: "POST",
      url: "/webhook/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(other) },
      payload: other,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("ignored");

    const rules = JSON.stringify({ commits: [{ modified: ["config/rules.yaml"] }] });
    res = await app.inject({
      method: "POST",
      url: "/webhook/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(rules) },
      payload: rules,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("accepted");

    await app.close();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it("/status 返回关键字段", async () => {
    const app = buildApp(stubManager());
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.server).toBe("Clash Config Manager");
    expect(data).toHaveProperty("update_interval");
    expect(data).toHaveProperty("next_update");
    await app.close();
  });
});
