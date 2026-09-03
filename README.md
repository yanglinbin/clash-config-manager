# Clash 配置管理器

自动化的 Clash 代理配置管理系统，支持多订阅源、自动更新、节点筛选和规则管理。

##  功能特性

-  **多订阅源管理** - 配置中可维护多个订阅源，当前只使用指定的一个
-  **单一供应商模式** - 配置中可维护多个订阅源，但只使用指定的一个（`active_provider`）
-  **直接内嵌节点** - 生成时直接拉取原始订阅并转换为节点列表写入配置，不依赖 proxy-providers
-  **自动更新** - 按配置的间隔定时重新生成配置（`[server] update_interval`）
-  **智能节点分组** - 按地区自动分组（香港、台湾、日本、美国、新加坡等）
-  **节点关键词过滤** - 自动过滤广告节点和无效节点
-  **自定义规则配置** - 灵活配置代理规则和分流规则
-  **生成前校验** - 校验组名唯一、节点/组引用完整、规则格式正确，失败时不覆盖旧配置
-  **Docker 部署** - 容器化部署，简单可靠
-  **Web 管理界面** - 提供状态查询和配置更新功能

---

##  快速开始

### 前置要求

- Docker 和 Docker Compose 已安装（应用运行于 Python 3.12）
- 已创建 `docker-shared-net` 网络
- Nginx 容器已部署并配置

>  **首次部署**？请查看完整部署指南：[DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md)

### 1. 创建网络（首次部署）

```bash
# 创建 Docker 共享网络
docker network create docker-shared-net
```

### 2. 准备配置

```bash
# 复制配置示例
cp config/config.ini.example config/config.ini

# 编辑配置，填入你的订阅链接
vim config/config.ini
```

### 3. 启动服务

```bash
# 使用 Docker Compose 启动
docker compose up -d

# 查看服务状态
docker compose ps
```

### 4. 配置 Nginx 代理

在 Nginx 配置中添加反向代理规则，将域名指向 `http://clash-config-manager:5000`

详细配置请参考：[DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md)

### 5. 访问服务

- **管理界面**: https://clash.yourdomain.com/
- **服务状态**: https://clash.yourdomain.com/status
- **Clash 配置**: https://clash.yourdomain.com/clash_profile.yaml

---

##  项目结构

```
clash-config-manager/
├── config/                 # 配置文件
│   ├── config.ini          # 主配置（运行必需，需自行创建）
│   ├── config.ini.example  # 配置示例（仅供参考）
│   ├── rules.yaml          # 规则配置（运行必需）
│   └── rules.schema.json   # JSON Schema（仅供验证）
├── src/                    # 源代码
│   ├── generate_clash_config.py  # 配置生成器
│   ├── app.py                     # Web 应用
│   └── frontend/                  # 前端资源
│       ├── html/                  # HTML 模板
│       ├── css/                   # 样式表
│       └── js/                    # JavaScript 脚本
├── output/                 # 生成的配置（自动创建）
├── logs/                   # 日志文件（自动创建）
├── Dockerfile              # Docker 镜像定义
├── docker-compose.yml      # Docker 编排配置
├── requirements.txt        # Python 依赖
└── main.py                 # 主入口（手动生成配置）
```

---

##  配置说明

### config.ini 主要配置

```ini
[proxy_providers]
# 订阅源配置
YOUR_PROVIDER = https://your-subscription-url

[regions]
# 地区分组配置
香港 = ,Hong Kong,HK,香港
台湾 = ,Taiwan,TW,台湾
日本 = ,Japan,JP,日本
美国 = ,United States,US,美国
新加坡 = ,Singapore,SG,新加坡

[filter]
# 节点过滤规则
exclude_keywords = 网址,剩余,流量,过期

[server]
# 更新间隔（秒）
update_interval = 3600
```

详细配置请参考 `config/config.ini.example`

---

##  Web 管理界面

访问 `http://your-server/` 可查看：

-  服务状态信息
-  配置文件状态
-  触发配置更新
-  API 接口文档

### API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 管理界面 |
| `/status` | GET | 服务状态（JSON） |
| `/update-config` | POST | 触发配置更新（可选 Bearer 令牌鉴权） |
| `/clash_profile.yaml` | GET | 获取生成的 Clash 配置 |

### 自动更新

Web 应用启动后按 `config.ini` 中 `[server] update_interval`（秒）定时重新生成配置，
也可通过环境变量 `UPDATE_INTERVAL` 覆盖。设为 `0` 或负值可关闭自动更新。
启动时若输出配置尚不存在，会立即在后台生成一次。

若在 `[files]` 中配置了 `rules_url`（或用环境变量 `RULES_URL` 覆盖），每次生成前会
先从该地址拉取最新 `rules.yaml`（默认指向本仓库 GitHub 的 `config/rules.yaml`）；
拉取失败或远程内容未通过校验时，自动回退到本地 `rules_config` 重新生成，避免更新中断。

### 更新令牌

通过环境变量 `UPDATE_TOKEN` 配置（`docker-compose.yml` 或启动环境）：
设置后 `/update-config` 需要携带 `Authorization: Bearer <token>`。

### 单一供应商模式

在 `config.ini` 中可以维护任意数量的订阅源，但通过 `active_provider` 指定**唯一**参与生成的供应商：

```ini
[proxy_providers]
XXAI = https://your-subscription-url-1
NAIYUN = https://your-subscription-url-2
KITTY = https://your-subscription-url-3

[provider_control]
active_provider = XXAI
```

上述配置会生成只包含 XXAI 的配置；NAIYUN、KITTY 保留在文件中但不参与任何组。
`active_provider` 为必填项，未配置时生成会失败并保留旧配置；环境变量
`ACTIVE_PROVIDER` 可覆盖此配置，便于不修改文件的情况下在 Docker 部署中切换。
若指定的提供者不存在，生成同样会失败并保留旧配置。

生成时系统会直接拉取 `active_provider` 的原始订阅链接，解析出节点后
将节点列表内嵌进生成配置（顶部 `proxies:` 字段），不再生成 proxy-providers，
也不依赖客户端运行时拉取订阅。

### 地区组

为 `[regions]` 中每个匹配到节点的地区生成一个地区组（如 `香港`），
组内显式列出名称匹配该地区关键词的节点；没有匹配节点的地区不会生成组。
地区组类型由 `[merged_regions]` 配置（`default_type` 和各地区覆盖）。

### 配置校验

- 生成前自动校验：代理组名称唯一、引用完整、类型合法、规则格式正确，校验失败不会覆盖旧配置
- 规则文件检查工具：`python scripts/lint_rules.py`（重复规则、重叠 CIDR、无效引用等）

---

##  常用命令

```bash
# 查看容器状态
docker compose ps

# 查看日志
docker compose logs -f

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 手动生成配置
docker compose exec clash-config-manager python main.py
```

---

##  安全提示

 **重要**：不要将以下文件提交到 Git：

- `config/config.ini` - 包含订阅链接
- `output/clash_profile.yaml` - 包含节点信息

这些文件已在 `.gitignore` 中配置。

---

##  文档

- **[config/config.ini.example](config/config.ini.example)** - 配置示例
- **[config/rules.yaml](config/rules.yaml)** - 规则配置

---

##  贡献

欢迎提交 Issue 和 Pull Request！

---

##  许可证

MIT License
