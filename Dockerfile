# Clash 配置管理器镜像（Node.js + TypeScript，多阶段构建）

# ---------- 构建阶段：安装依赖并编译 TS ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.web.json tsup.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- 运行阶段：仅保留产物与生产依赖 ----------
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    APP_PORT=5000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 服务端产物 + 静态资源（html/css/编译后的 js）
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# 运行时目录（config 由 compose 挂载；logs/output 需要可写）
RUN mkdir -p config logs output

EXPOSE 5000

# 健康检查用 Node 内置 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||5000)+'/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
