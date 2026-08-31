#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clash Config Manager Web 应用
提供配置状态查询、配置更新、自动更新调度和 GitHub Webhook 接口
"""

import functools
import hashlib
import hmac
import json
import logging
import os
import subprocess
import sys
import threading
import time
import configparser
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

# 获取项目根目录（app.py 在 src/ 下，需要向上一级）
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "output"
OUTPUT_FILE = OUTPUT_DIR / "clash_profile.yaml"
STATS_FILE = OUTPUT_DIR / "stats.json"
LAST_UPDATE_FILE = OUTPUT_DIR / "last_update.txt"

# 确保日志目录存在
(PROJECT_ROOT / "logs").mkdir(parents=True, exist_ok=True)

# 配置日志
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(PROJECT_ROOT / "logs" / "app.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# 配置 Flask 应用
template_dir = Path(__file__).parent / "frontend" / "html"
static_dir = Path(__file__).parent / "frontend"

app = Flask(
    __name__,
    template_folder=str(template_dir),
    static_folder=str(static_dir),
    static_url_path="/static",
)


def get_update_token() -> str:
    """获取更新令牌（UPDATE_TOKEN 优先，WEBHOOK_SECRET 作为备用来源）。"""
    return os.environ.get("UPDATE_TOKEN") or os.environ.get("WEBHOOK_SECRET") or ""


def require_update_token(route_func):
    """要求请求携带有效的更新令牌（未配置令牌时放行）。"""

    @functools.wraps(route_func)
    def wrapper(*args, **kwargs):
        token = get_update_token()
        if token:
            provided = ""
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                provided = auth[len("Bearer "):]
            else:
                provided = request.headers.get("X-Update-Token", "") or ""
            if not hmac.compare_digest(provided, token):
                return (
                    jsonify(
                        {
                            "error": "Unauthorized",
                            "message": "缺少或错误的更新令牌",
                        }
                    ),
                    401,
                )
        return route_func(*args, **kwargs)

    return wrapper


class ConfigManager:
    def __init__(self, config_file="config/config.ini"):
        self.config_file = PROJECT_ROOT / config_file
        self.config = configparser.ConfigParser()
        self.load_config()
        self._update_lock = threading.Lock()
        self._scheduler_started = False
        self.last_update = self._read_last_update()

    def load_config(self):
        """加载配置文件"""
        if self.config_file.exists():
            self.config.read(self.config_file, encoding="utf-8")
            logger.info(f"已加载配置文件: {self.config_file}")
        else:
            logger.warning(f"配置文件 {self.config_file} 不存在")

    def _read_last_update(self) -> datetime | None:
        """从磁盘读取上次更新时间（重启后不丢失）。"""
        try:
            if LAST_UPDATE_FILE.exists():
                text = LAST_UPDATE_FILE.read_text(encoding="utf-8").strip()
                if text:
                    return datetime.fromisoformat(text)
        except Exception:
            pass
        try:
            if OUTPUT_FILE.exists():
                return datetime.fromtimestamp(OUTPUT_FILE.stat().st_mtime)
        except Exception:
            pass
        return None

    def _write_last_update(self, update_time: datetime):
        """持久化上次更新时间。"""
        try:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            LAST_UPDATE_FILE.write_text(update_time.isoformat(), encoding="utf-8")
        except Exception as e:
            logger.warning(f"写入 last_update 失败: {e}")

    def _get_update_interval(self) -> int:
        """获取自动更新间隔（秒）。环境变量 UPDATE_INTERVAL 优先，0 或负值表示禁用。"""
        env_value = os.environ.get("UPDATE_INTERVAL")
        if env_value is not None:
            try:
                return int(env_value)
            except ValueError:
                logger.warning(f"环境变量 UPDATE_INTERVAL 无效: {env_value!r}")
        try:
            return self.config.getint("server", "update_interval", fallback=0)
        except ValueError:
            logger.warning("config.ini 中 update_interval 无效，自动更新已禁用")
            return 0

    def regenerate_config(self) -> bool:
        """重新生成配置文件（带互斥锁，防止并发覆盖）。"""
        with self._update_lock:
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        str(PROJECT_ROOT / "src" / "generate_clash_config.py"),
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=120,
                    cwd=str(PROJECT_ROOT),
                )

                if result.returncode == 0:
                    self.last_update = datetime.now()
                    self._write_last_update(self.last_update)
                    logger.info("配置文件重新生成成功")
                    return True

                logger.error(
                    f"配置文件生成失败: {(result.stderr or result.stdout).strip()}"
                )
                return False

            except subprocess.TimeoutExpired:
                logger.error("配置生成超时")
                return False
            except Exception as e:
                logger.error(f"生成配置异常: {e}")
                return False

    def start_scheduler(self):
        """启动自动更新调度线程（幂等）。"""
        if self._scheduler_started:
            return
        interval = self._get_update_interval()
        if interval <= 0:
            logger.info("自动更新未启用（update_interval <= 0）")
            return

        self._scheduler_started = True
        thread = threading.Thread(
            target=self._scheduler_loop,
            daemon=True,
            name="config-auto-updater",
        )
        thread.start()
        logger.info(f"自动更新调度已启动，间隔 {interval} 秒")

        # 启动时若配置尚不存在，立即在后台生成一次
        if not OUTPUT_FILE.exists():
            initial = threading.Thread(
                target=self.regenerate_config,
                daemon=True,
                name="config-initial-generation",
            )
            initial.start()

    def _scheduler_loop(self):
        """调度循环：每次唤醒后重新读取配置，使间隔修改无需重启。"""
        while True:
            interval = self._get_update_interval()
            if interval <= 0:
                logger.info("update_interval <= 0，自动更新调度退出")
                break
            time.sleep(interval)
            self.load_config()
            try:
                self.regenerate_config()
            except Exception as e:
                logger.error(f"定时更新异常: {e}")

    def _read_stats(self) -> dict | None:
        """读取生成器输出的统计信息。"""
        try:
            if STATS_FILE.exists():
                return json.loads(STATS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
        return None


config_manager = ConfigManager()


@app.route("/status")
def status():
    """状态查询接口（JSON格式）"""
    status_info = {
        "server": "Clash Config Manager",
        "status": "running",
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "last_update": (
            config_manager.last_update.isoformat(timespec="seconds")
            if config_manager.last_update
            else None
        ),
        "config_file": "output/clash_profile.yaml",
        "update_interval": config_manager._get_update_interval(),
    }

    interval = status_info["update_interval"]
    if interval > 0:
        base = config_manager.last_update or datetime.now()
        status_info["next_update"] = (base + timedelta(seconds=interval)).isoformat(
            timespec="seconds"
        )
    else:
        status_info["next_update"] = None

    # 检查配置文件是否存在
    config_exists = OUTPUT_FILE.exists()
    status_info["config_file_exists"] = config_exists
    if config_exists:
        config_stat = OUTPUT_FILE.stat()
        status_info["config_file_size"] = config_stat.st_size
        status_info["config_file_modified"] = datetime.fromtimestamp(
            config_stat.st_mtime
        ).isoformat(timespec="seconds")

    # 生成统计信息
    stats = config_manager._read_stats()
    if stats:
        status_info["stats"] = stats

    # 是否要求更新令牌
    status_info["need_update_token"] = bool(get_update_token())

    return jsonify(status_info)


@app.route("/update-config", methods=["POST"])
@require_update_token
def update_config():
    """配置更新"""
    try:
        logger.info("收到更新请求")

        if config_manager.regenerate_config():
            return jsonify(
                {
                    "status": "success",
                    "message": "Config updated successfully",
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                }
            )
        else:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Config update failed",
                        "timestamp": datetime.now().isoformat(timespec="seconds"),
                    }
                ),
                500,
            )

    except Exception as e:
        logger.error(f"更新异常: {e}")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/webhook/github", methods=["POST"])
def github_webhook():
    """GitHub Webhook 入口：校验 HMAC 签名后触发配置更新。"""
    secret = os.environ.get("WEBHOOK_SECRET", "")
    if not secret:
        return jsonify({"error": "Webhook 未配置（WEBHOOK_SECRET 为空）"}), 503

    signature = request.headers.get("X-Hub-Signature-256", "")
    payload = request.get_data()
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    if not signature or not hmac.compare_digest(signature, expected):
        logger.warning("Webhook 签名校验失败")
        return jsonify({"error": "Invalid signature"}), 401

    event = request.headers.get("X-GitHub-Event", "")
    if event == "ping":
        logger.info("收到 GitHub Webhook ping")
        return jsonify({"status": "pong"}), 200

    thread = threading.Thread(
        target=config_manager.regenerate_config,
        daemon=True,
        name="webhook-update",
    )
    thread.start()
    logger.info("收到 GitHub Webhook，已触发配置更新")
    return jsonify({"status": "accepted", "message": "Update triggered"}), 202


@app.route("/clash_profile.yaml")
def get_clash_config():
    """获取生成的Clash配置文件"""
    if OUTPUT_FILE.exists():
        return send_file(
            str(OUTPUT_FILE),
            mimetype="text/yaml",
            as_attachment=False,
            download_name="clash_profile.yaml",
        )
    else:
        return jsonify({"error": "配置文件不存在"}), 404


@app.route("/")
def index():
    """主页 - Web 管理界面"""
    stats = config_manager._read_stats()
    interval = config_manager._get_update_interval()
    last_update = (
        config_manager.last_update.strftime("%Y-%m-%d %H:%M:%S")
        if config_manager.last_update
        else "从未更新"
    )
    if interval > 0:
        base = config_manager.last_update or datetime.now()
        next_update = (base + timedelta(seconds=interval)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        update_interval_text = f"每 {interval} 秒"
    else:
        next_update = None
        update_interval_text = "未启用"

    return render_template(
        "index.html",
        current_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        last_update=last_update,
        next_update=next_update,
        update_interval_text=update_interval_text,
        config_exists=" 存在" if OUTPUT_FILE.exists() else " 不存在",
        stats=stats,
        need_token=bool(get_update_token()),
    )


def main():
    """主函数"""
    # 端口配置优先级：环境变量 > 默认值
    port = int(os.environ.get("APP_PORT", 5000))
    host = "0.0.0.0"  # Docker容器内需要监听所有接口

    port_source = "环境变量" if "APP_PORT" in os.environ else "默认值"
    logger.info(f"启动 Web 服务器: {host}:{port} (端口来源: {port_source})")
    logger.info(f"模板目录: {template_dir}")
    logger.info(f"静态文件目录: {static_dir}")

    # 启动自动更新调度（gunicorn 场景下由模块导入触发）
    config_manager.start_scheduler()

    # 启动服务器
    app.run(host=host, port=port, debug=False)


# gunicorn 导入 src.app:app 时也会启动调度线程
config_manager.start_scheduler()

if __name__ == "__main__":
    main()
