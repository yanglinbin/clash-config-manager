# Clash 配置管理器 - Docker 镜像
# 多阶段构建，优化镜像大小

# ==================== 构建阶段 ====================
FROM python:3.12-slim AS builder

# 设置工作目录
WORKDIR /build

# 复制依赖文件
COPY requirements.txt .

# 使用阿里云镜像源加速 pip 下载（国内服务器加速）
RUN pip install --no-cache-dir --user \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    -r requirements.txt

# ==================== 运行阶段 ====================
FROM python:3.12-slim

# 设置环境变量
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    APP_HOME=/app

# 配置阿里云镜像源加速 apt 下载
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list && \
    sed -i 's|http://security.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list

# 安装必要的系统工具
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tzdata && \
    rm -rf /var/lib/apt/lists/*

# 创建非root用户
RUN groupadd -r appuser && \
    useradd -r -g appuser -u 1000 -m -s /bin/bash appuser

# 设置工作目录
WORKDIR ${APP_HOME}

# 从构建阶段复制Python依赖（设置正确的权限）
COPY --from=builder --chown=appuser:appuser /root/.local /home/appuser/.local

# 复制应用代码
COPY --chown=appuser:appuser main.py .
COPY --chown=appuser:appuser src/ ./src/

# 创建必要的目录并设置权限
# 注意：config.ini 和 rules.yaml 由用户通过 docker-compose.yml 卷挂载提供
RUN mkdir -p logs output backups config && \
    chown -R appuser:appuser ${APP_HOME}

# 切换到非root用户
USER appuser

# 设置Python路径（包含用户安装的包）
ENV PATH="/home/appuser/.local/bin:${PATH}" \
    PYTHONPATH="/home/appuser/.local/lib/python3.12/site-packages:${PYTHONPATH}"

# 暴露端口（Flask 默认端口）
EXPOSE 5000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f "http://localhost:${APP_PORT:-5000}/status" || exit 1

# 启动应用
# 使用 gunicorn 作为生产级 WSGI 服务器
# 单 worker + 多线程：自动更新调度与 last_update 状态需进程内一致
# 端口由 APP_PORT 环境变量控制（默认 5000）
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${APP_PORT:-5000} --workers 1 --threads 8 --timeout 120 --access-logfile logs/access.log --error-logfile logs/error.log src.app:app"]

