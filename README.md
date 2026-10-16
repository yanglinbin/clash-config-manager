# Clash 配置管理器

自动化的 Clash / Mihomo 配置管理服务：读取 `config.ini`（订阅源、地区关键词、过滤、基础参数）、
`groups.yaml`（代理组结构）与 `rules.yaml`（分流规则），生成可用配置并通过 Web 界面 / 接口对外提供，
支持手动触发与可选的 git 自动轮询更新。

> **技术栈**：Node.js 20 + TypeScript + Fastify，前端同为 TypeScript。
> **部署**：Docker Compose（应用容器 + Nginx 反代），也支持裸机运行。

---

## 功能特性

- **单一供应商模式** — `config.ini` 可维护多个订阅源，只启用 `active_provider` 指定的一个
- **订阅链接模式** — 生成时把订阅链接写入 `proxy-providers`，节点由客户端自行拉取，服务器无需访问订阅源
- **智能地区分组** — 按地区关键词自动分组（香港、台湾、日本、美国、新加坡等）
- **节点关键词过滤** — 通过策略组 `filter` 负向前瞻排除广告 / 信息节点
- **自定义组** — 按用途组合地区/节点（详见 `config/groups.yaml`）
- **生成前校验** — `rules.yaml` / `groups.yaml` 通过 JSON Schema；组名唯一、引用完整（含 `RULE-SET` provider）、类型合法、CIDR/规则格式正确；失败时不覆盖旧配置
- **手动触发** — 页面与接口手动触发（无定时自动更新）
- **Web 管理界面 + HTTP 接口**

---

## 快速开始

> 完整步骤见 **[部署手册.md](./部署手册.md)**。这里是最短路径。

```bash
# 1. 准备配置
cp .env.example .env                                   # 可选：端口 / 时区
cp config/config.ini.example config/config.ini         # 填入订阅链接与 active_provider

# 2. 构建并启动（本地构建镜像）
docker compose up -d --build

# 3. 验证
curl -s http://localhost/status

# 4. 启用 HTTPS：把证书放到 nginx/certs/ 后重建 nginx（文件名需与 nginx/default.conf 一致）
cp cert.crt cert.key nginx/certs/
docker compose up -d --force-recreate nginx
```

访问：

- 管理界面 `https://<你的域名>/`
- 服务状态 `https://<你的域名>/status`
- Clash 配置 `https://<你的域名>/clash_profile.yaml`

> 域名填在 `nginx/default.conf` 的 `server_name`（默认 `clash.yilabao.top`）。
> 证书放置与文件名详见 [nginx/certs/README.md](nginx/certs/README.md)。

**前置要求**：Docker 20.10+ 与 Docker Compose v2。
首次构建需要能访问 npm registry 与 Docker Hub（拉取 `node:20-alpine`、`nginx:1.30-alpine`）。

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
│   │   ├── config.ts              #   config.ini / rules.yaml / groups.yaml 解析
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
│   ├── groups.yaml         #   代理组结构（运行必需）
│   ├── groups.schema.json  #   分组 JSON Schema
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
├── eslint.config.js        # ESLint 扁平配置
├── .prettierrc             # Prettier 配置
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
groups_config = config/groups.yaml   # 分组结构文件

[clash]
port = 7890
socks_port = 7891
mode = Rule
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

### 分组配置（config/groups.yaml）

代理组结构（主组 / 地区组 / 自定义组）统一在 `config/groups.yaml` 定义，
`config.ini` 只保留地区关键词词典：

```yaml
version: 1
region_groups:
  type: fallback            # 地区组默认类型
  overrides: { 香港: select }
main:
  # 派生组：不写 proxies，成员由 regions/targets/DIRECT 派生
  - name: 海外代理
    type: select
    regions: all            # all | none | [香港, 日本]（缺省 all）
    default: 香港           # 可选
    nodes: true             # 缺省 true：直接纳入 provider 原始节点
    direct: true            # 缺省 true：末尾追加 DIRECT
  # 字面量组：写了 proxies，成员就是它，不再派生
  - name: 广告拦截
    type: select
    proxies: [REJECT, DIRECT]
custom:
  - name: AI专用
    type: fallback
    regions: [香港, 日本]
    targets: [AI平台]        # 缺省 = 全部主组
```

派生组 `proxies` 顺序固定：默认节点 → 地区组 → 自定义组 → DIRECT；
写了 `proxies` 的为**字面量组**，直接使用（与派生字段互斥）。
结构由 `config/groups.schema.json`（ajv）校验，引用不存在时**报错并保留旧配置**。
旧版散落在 `config.ini` 的分组节可用 `npm run migrate:groups` 迁移。

### 配置校验

- **规则/分组 Schema**：加载 `rules.yaml`（`config/rules.schema.json`）与 `groups.yaml`
  （`config/groups.schema.json`）时用 ajv 校验，错误带字段路径
- **生成前校验**：代理组名称唯一、引用完整（含 `RULE-SET` 的 provider）、类型合法、
  filter 正则有效、CIDR 合法、规则格式正确；校验失败不会覆盖旧配置
- **规则 lint**：`npm run lint:rules`（重复规则、重叠 CIDR、无效引用等）

---

## Web 管理界面与接口

访问 `http://<服务器IP>/` 可查看服务状态、配置信息、更新间隔，并触发/下载配置。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 管理界面 |
| `/status` | GET | 服务状态（JSON） |
| `/update-config` | POST | 触发配置更新 |
| `/clash_profile.yaml` | GET | 获取生成的 Clash 配置（支持 `ETag` / `304`） |
| `/static/*` | GET | 静态资源（css / js） |

---

## 触发更新

配置在以下时机重新生成：

1. 页面「更新配置」按钮，或 `POST /update-config`（手动）
2. 服务启动时若输出配置尚不存在，自动生成一次
3. **可选**：应用内定时轮询 git 仓库，检测到 `config/rules.yaml` 变化后自动重新生成（见下）

### 自动轮询（可选，应对入站不可达）

在 `config/config.ini` 打开 `[git]`：

```ini
[git]
enable = true
repo = https://github.com/<你>/clash-config-manager.git
branch = main
interval = 300
watched_paths = config/rules.yaml
```

服务器会**主动出站** `git clone/fetch` 到独立工作区（默认 `<项目根>/repo`，容器内 `/app/repo`），
只有 `watchedPaths` 中的文件变化才触发重新生成；拉取失败时回退到挂载的 `config/rules.yaml`，
不影响服务。公开仓库匿名 https 即可，**无需任何 token**。状态见 `GET /status` 的 `git` 字段。

### 手动更新规则

规则默认来自本地 `config/rules.yaml`（`[files] rules_config`）。未启用自动轮询时，
先更新宿主机的规则文件，再触发重新生成：

```bash
cd /path/to/clash-config-manager
git pull            # 更新 config/rules.yaml
docker compose exec clash-config-manager node dist/cli/generate.js
```

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
npm run migrate:groups # 把旧分组配置迁移到 config/groups.yaml
npm test             # vitest（含与黄金文件的语义对照）
npm run typecheck    # 类型检查
npm run lint         # ESLint
npm run format       # Prettier 格式化（format:check 用于 CI）
```

---

## 安全提示

**重要**：不要将以下文件提交到 Git（已在 `.gitignore`）：

- `config/config.ini` — 包含订阅链接
- `output/clash_profile.yaml` — 包含节点信息

生产环境建议：

- 使用 HTTPS 对外暴露
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
