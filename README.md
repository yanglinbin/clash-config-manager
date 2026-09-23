# Clash 配置管理器

自动化的 Clash / Mihomo 配置管理服务：读取 `config.ini`（订阅源、地区、过滤、代理组）与
`rules.yaml`（分流规则），生成可用配置并通过 Web 界面 / 接口对外提供，支持手动与 GitHub Webhook 触发更新。

> **技术栈**：Node.js 20 + TypeScript + Fastify，前端同为 TypeScript。
> **部署**：Docker Compose（应用容器 + Nginx 反代），也支持裸机运行。

---

## 功能特性

- **单一供应商模式** — `config.ini` 可维护多个订阅源，只启用 `active_provider` 指定的一个
- **订阅链接模式** — 生成时把订阅链接写入 `proxy-providers`，节点由客户端自行拉取，服务器无需访问订阅源
- **智能地区分组** — 按地区关键词自动分组（香港、台湾、日本、美国、新加坡等）
- **节点关键词过滤** — 通过策略组 `filter` 负向前瞻排除广告 / 信息节点
- **自定义组 / 中继组** — 按用途组合地区，可选中继组
- **生成前校验** — 组名唯一、引用完整、类型合法、规则格式正确；失败时不覆盖旧配置
- **手动 / Webhook 触发** — 页面与接口手动触发，或 GitHub push 即时触发（不再有定时自动更新）
- **GitHub Webhook** — push 变更 `rules.yaml` 后即时触发重新生成（HMAC-SHA256 校验）
- **Web 管理界面 + HTTP 接口**

---

## 快速开始

> 完整步骤见 **[部署手册.md](./部署手册.md)**。这里是最短路径。

```bash
# 1. 准备配置
cp .env.example .env                                   # 可选：端口 / 时区 / Webhook 密钥
cp config/config.ini.example config/config.ini         # 填入订阅链接与 active_provider

# 2. 构建并启动（本地构建镜像）
docker compose up -d --build

# 3. 验证
curl -s http://localhost/status

# 4. 启用 HTTPS：把证书放到 nginx/certs/ 后重建 nginx
cp 你的证书.pem nginx/certs/fullchain.pem
cp 你的私钥.key nginx/certs/privkey.pem
docker compose up -d --force-recreate nginx
```

访问：

- 管理界面 `https://<你的域名>/`
- 服务状态 `https://<你的域名>/status`
- Clash 配置 `https://<你的域名>/clash_profile.yaml`

> 域名填在 `nginx/default.conf` 的 `server_name`（默认 `clash.yilabao.top`）。
> 证书放置与文件名详见 [nginx/certs/README.md](nginx/certs/README.md)。

**前置要求**：Docker 20.10+ 与 Docker Compose v2。
首次构建需要能访问 npm registry 与 Docker Hub（拉取 `node:20-alpine`、`nginx:alpine`）。

若需要与其他容器互联（如外部 Nginx），可选地创建共享网络：

```bash
docker network create docker-shared-net
```

---

## 项目结构

```
clash-config-manager/
├── src/                    # 后端源代码（TypeScript）
│   ├── index.ts                   # 服务入口（Fastify 启动）
│   ├── server/app.ts              # Fastify 应用与路由
│   ├── services/configManager.ts  # 状态 / 生成触发 / 互斥锁
│   ├── clash/                     # 生成器核心
│   │   ├── generator.ts           #   配置生成器
│   │   ├── config.ts              #   config.ini + rules.yaml 解析
│   │   ├── rules.ts               #   规则公共常量与校验
│   │   └── types.ts               #   类型定义
│   ├── cli/                       # 命令行入口
│   │   ├── generate.ts            #   手动生成配置
│   │   └── lint.ts                #   规则文件 lint
│   ├── utils/                     # 工具（ini / cidr / yaml / regex / log / time ...）
│   └── web/app.ts                 # 前端源码（TypeScript，编译到 public/js）
├── public/                 # 静态资源（由 Fastify 托管）
│   ├── index.html          #   管理界面（纯静态）
│   ├── css/style.css       #   样式表
│   └── js/                 #   前端编译产物（自动生成，已忽略）
├── tests/                  # vitest 测试（含黄金文件对照）
├── config/                 # 配置
│   ├── config.ini          #   主配置（运行必需，需自行创建）
│   ├── config.ini.example  #   配置示例
│   ├── rules.yaml          #   分流规则（运行必需）
│   └── rules.schema.json   #   JSON Schema（仅供校验）
├── clash_rules/            # 规则集文本（Microsoft.txt，被 rules.yaml 的 rule-provider 引用）
├── output/                 # 生成结果（自动创建）
├── logs/                   # 日志文件（自动创建）
├── dist/                   # 服务端构建产物（自动生成，已忽略）
├── nginx/
│   ├── default.conf        #   Nginx 站点配置（HTTPS，绑定挂载进容器）
│   └── certs/              #   TLS 证书（自行上传，已忽略；含 README）
├── .github/workflows/ci.yml  # CI（类型检查 / 测试 / 构建 / 镜像）
├── .env.example            # 环境变量示例
├── Dockerfile              # Docker 镜像定义（多阶段）
├── compose.yaml            # Docker Compose 编排配置
├── package.json            # 依赖与脚本
├── tsconfig.json           # 后端 TS 配置
├── tsconfig.web.json       # 前端 TS 配置
├── tsup.config.ts          # 服务端打包配置
├── vitest.config.ts        # 测试配置
├── README.md               # 本文件
└── 部署手册.md             # 完整部署与运维指南
```

---

## 配置说明

### config.ini 主要配置

```ini
[proxy_providers]
# 订阅源：可维护多个，只用 active_provider 指定的那个
MY_PROVIDER = https://your-subscription-url

[provider_control]
active_provider = MY_PROVIDER        # 必填：唯一启用的订阅源（大小写不敏感）

[regions]
# 地区分组：地区名 = 匹配关键词（节点名包含任一关键词即归入）
香港 = Hong Kong,HK,香港,HongKong
日本 = Japan,JP,日本,Tokyo

[filter]
# 全局排除：命中任一关键词的节点不会出现在任何组
exclude_keywords = 剩余,官网,到期

[files]
rules_config = config/rules.yaml     # 规则文件（本地文件）

[clash]
port = 7890
socks_port = 7891
mode = Rule

[merged_regions]
default_type = url-test              # 地区组类型

[proxy_group_defaults]               # 可选：各主组默认选中项
海外代理 = 香港
全球直连 = DIRECT
```

完整字段与说明见 **[config/config.ini.example](config/config.ini.example)** 与
**[部署手册.md · config.ini 配置参考](./部署手册.md)**。

### 单一供应商模式

`config.ini` 可维护任意数量订阅源，但只有 `active_provider` 指定的那个参与生成；
其余订阅源保留在文件中但不参与任何组。`active_provider` 为必填项，未配置或指定的
提供者不存在时，生成失败并保留旧配置。

生成结果里只写入该订阅源链接（`proxy-providers`），节点由 Clash/Mihomo 客户端
按配置间隔自行拉取，服务器不需要访问订阅源。

### 节点过滤

`[filter] exclude_keywords` 为全局排除：节点名包含任一关键词（如“剩余流量”“官网”“到期”）
就不会出现在生成的任何组中。关键词会写进策略组 `filter` 的负向前瞻
（主组与地区组都会带上），由客户端过滤信息节点
（依赖 Mihomo/Clash.Meta 支持的 filter 正则语法）。未配置或留空时不做任何排除。

### 地区组与组类型

为 `[regions]` 中每个地区生成一个地区组（如 `香港`），通过 `use` + `filter`
按节点名关键词匹配。组类型由 `[merged_regions]` 配置，优先级：

```
[merged_regions] 地区键 > [merged_regions] default_type
> [clash] group_type_地区 > [clash] default_group_type
```

### 配置校验

- **生成前校验**：代理组名称唯一、引用完整、类型合法、filter 正则有效、规则格式正确；
  校验失败不会覆盖旧配置
- **规则 lint**：`npm run lint:rules`（重复规则、重叠 CIDR、无效引用等）

---

## Web 管理界面与接口

访问 `http://<服务器IP>/` 可查看服务状态、配置信息、更新间隔，并触发/下载配置。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 管理界面 |
| `/status` | GET | 服务状态（JSON） |
| `/update-config` | POST | 触发配置更新 |
| `/webhook/github` | POST | GitHub Webhook（HMAC-SHA256 校验） |
| `/clash_profile.yaml` | GET | 获取生成的 Clash 配置 |
| `/static/*` | GET | 静态资源（css / js） |

---

## 触发更新

配置只在以下时机重新生成（**无定时自动更新**）：

1. 页面「更新配置」按钮，或 `POST /update-config`
2. GitHub Webhook（push 变更 `config/rules.yaml` 时）
3. 服务启动时若输出配置尚不存在，自动生成一次

规则来自本地 `config/rules.yaml`（`[files] rules_config`）。

### 推送后即时更新（GitHub Webhook）

仓库 push 变更 `config/rules.yaml` 后，可由 GitHub Webhook 触发服务立即重新生成：

1. `.env` 中设置密钥（`openssl rand -hex 32`）：

   ```dotenv
   GITHUB_WEBHOOK_SECRET=你的随机密钥
   ```

2. GitHub 仓库 → Settings → Webhooks → Add webhook：
   **Payload URL** `https://<你的域名>/webhook/github`、
   **Content type** `application/json`、**Secret** 同上、
   **Which events** 仅 `Just the push event`。

行为：仅当 push 涉及 `config/rules.yaml` 时触发；接口立即返回 `202`，生成在后台进行；
密钥未配置返回 `503`，签名不匹配返回 `401`。

> **注意**：规则只来自宿主机挂载的 `config/rules.yaml`。Webhook 只负责触发「重新生成」，
> 因此需保证宿主机上的规则文件已更新（例如宿主机定时 `git pull`），否则读到的仍是旧规则。

---

## 常用命令

```bash
# 构建 / 重新构建镜像
docker compose build
docker compose up -d --build

# 状态 / 日志 / 重启 / 停止
docker compose ps
docker compose logs -f
docker compose restart
docker compose down

# 手动生成配置
docker compose exec clash-config-manager node dist/cli/generate.js

# 规则 lint
docker compose exec clash-config-manager node dist/cli/lint.js
```

### 本地开发（不使用 Docker）

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（tsx 直跑 src/index.ts，热重载）
npm run build        # 编译服务端（tsup）与前端（tsc）
npm start            # 运行构建产物 dist/index.js（默认 0.0.0.0:5000）
npm run generate     # 手动生成配置
npm run lint:rules   # 规则文件 lint
npm test             # vitest（含与黄金文件的语义对照）
npm run typecheck    # 类型检查
```

---

## 安全提示

**重要**：不要将以下文件提交到 Git（已在 `.gitignore`）：

- `config/config.ini` — 包含订阅链接
- `output/clash_profile.yaml` — 包含节点信息

生产环境建议：

- 使用 HTTPS 对外暴露；Webhook 依赖 `GITHUB_WEBHOOK_SECRET` 签名保护，勿置空
- `POST /update-config` 为公开触发接口（无鉴权），公网暴露时建议在 Nginx 层限制来源或加访问控制
- `config` 以只读方式挂载，仅 `output` / `logs` 可写

---

## 文档

- **[部署手册.md](./部署手册.md)** — 完整部署与运维指南
- **[config/config.ini.example](config/config.ini.example)** — 配置示例
- **[config/rules.yaml](config/rules.yaml)** — 规则配置
- **[config/rules.schema.json](config/rules.schema.json)** — 规则 JSON Schema

---

## 许可证

MIT License
