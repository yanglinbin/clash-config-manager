// Clash Config Manager - 前端脚本（TypeScript）

interface StatusStats {
  providers?: number;
  groups?: number;
  rules?: number;
  generated_at?: string;
}

interface StatusPayload {
  timestamp?: string;
  last_update?: string | null;
  update_interval?: number;
  next_update?: string | null;
  config_file_exists?: boolean;
  config_file_size?: number | null;
  stats?: StatusStats;
}

const REFRESH_INTERVAL_MS = 60 * 1000; // 页面可见时每 60 秒自动同步一次状态

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(text: unknown): string {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function setText(id: string, text: unknown): void {
  const el = byId(id);
  if (el) el.textContent = String(text === undefined || text === null ? "" : text);
}

function showResult(className: string, html: string): void {
  const resultDiv = byId("result");
  if (!resultDiv) return;
  resultDiv.hidden = false;
  resultDiv.className = `status ${className}`;
  resultDiv.innerHTML = html;
}

function showHint(message: string): void {
  const hint = byId("refresh-hint");
  if (!hint) return;
  hint.hidden = false;
  hint.textContent = message;
}

function setBusy(button: HTMLButtonElement | null, busy: boolean): void {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  button.classList.toggle("is-busy", busy);
}

function formatTime(iso?: string | null): string {
  if (!iso) return "从未更新";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatInterval(seconds?: number): string {
  if (typeof seconds !== "number" || seconds <= 0) return "未启用";
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "每小时" : `每 ${hours} 小时`;
  }
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

function numOrDash(value?: number): string {
  return typeof value === "number" ? String(value) : "—";
}

function applyStatus(data: StatusPayload): void {
  setText("current-time", formatTime(data.timestamp));
  setText("last-update", formatTime(data.last_update));
  setText("update-interval", formatInterval(data.update_interval));
  setText("next-update", data.next_update ? formatTime(data.next_update) : "未启用");

  setText("config-file", data.config_file_exists ? "存在" : "不存在");
  setText(
    "config-size",
    data.config_file_size != null ? formatSize(data.config_file_size) : "—",
  );

  const stats = data.stats ?? {};
  setText("stat-providers", numOrDash(stats.providers));
  setText("stat-groups", numOrDash(stats.groups));
  setText("stat-rules", numOrDash(stats.rules));
  setText("stat-generated", stats.generated_at ? formatTime(stats.generated_at) : "尚未生成");
}

let refreshing = false;
async function refreshStatus(silent: boolean): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    applyStatus((await response.json()) as StatusPayload);
    if (!silent) {
      showHint(`状态已刷新 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
    }
  } catch (error) {
    if (!silent) {
      showResult("error", `<h3>状态刷新失败</h3><p>${escapeHtml((error as Error).message ?? error)}</p>`);
    }
  } finally {
    refreshing = false;
  }
}

async function updateConfig(): Promise<void> {
  const btn = byId<HTMLButtonElement>("update-btn");
  if (!btn || btn.disabled) return;
  setBusy(btn, true);
  showResult("info", "<p>正在更新配置…</p>");
  try {
    const response = await fetch("/update-config", { method: "POST" });
    let data: { status?: string; message?: string; error?: string; timestamp?: string } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      // 响应不是 JSON 时按空数据处理
    }

    if (response.ok && data.status === "success") {
      showResult("success", `<h3>更新成功</h3><p>时间: ${escapeHtml(formatTime(data.timestamp))}</p>`);
      await refreshStatus(true);
    } else {
      showResult(
        "error",
        `<h3>更新失败</h3><p>${escapeHtml(data.message ?? data.error ?? `HTTP ${response.status}`)}</p>`,
      );
    }
  } catch (error) {
    showResult("error", `<h3>更新失败</h3><p>${escapeHtml((error as Error).message ?? error)}</p>`);
  } finally {
    setBusy(btn, false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const updateBtn = byId<HTMLButtonElement>("update-btn");
  if (updateBtn) updateBtn.addEventListener("click", () => void updateConfig());

  const refreshBtn = byId<HTMLButtonElement>("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      void (async () => {
        if (refreshBtn.disabled) return;
        setBusy(refreshBtn, true);
        await refreshStatus(false);
        setBusy(refreshBtn, false);
      })();
    });
  }

  // 首屏同步一次；之后页面可见时定时自动同步
  void refreshStatus(true);
  setInterval(() => {
    if (!document.hidden) void refreshStatus(true);
  }, REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshStatus(true);
  });
});
