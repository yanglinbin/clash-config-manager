#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clash 配置生成器 - 服务器版本
支持动态生成代理组、生成前校验、原子写入和自动备份
"""

import json
import os
import base64
import shutil
import sys
import time
import configparser
import logging
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

import yaml


PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# 配置日志
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "clash_generator.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# Clash 内置的代理关键字（引用检查时无需匹配代理组）
BUILTIN_PROXIES = {"DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"}

# 允许的代理组类型
VALID_GROUP_TYPES = {"select", "url-test", "fallback", "load-balance", "relay"}

# 允许的规则类型（用于生成前基础校验）
VALID_RULE_TYPES = {
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX",
    "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE",
    "SRC-IP-CIDR", "SRC-PORT", "DST-PORT", "SRC-IP-ASN",
    "PROCESS-NAME", "PROCESS-PATH", "RULE-SET", "MATCH",
    "AND", "OR", "NOT", "SUB-RULE",
}


class ClashConfigGenerator:
    def __init__(self, config_file: Optional[str] = None):
        if config_file is None:
            config_file = str(PROJECT_ROOT / "config" / "config.ini")
        self.config_file = str(Path(config_file))
        # 创建 ConfigParser 并保留键名的大小写
        self.config = configparser.RawConfigParser()
        self.config.optionxform = str
        self.rules_config = {}
        self._test_url_cache: Optional[str] = None
        self._nodes_cache: Optional[List[Dict[str, Any]]] = None
        self.load_config()

        # 从配置文件获取规则文件路径
        rules_file = self.config.get("files", "rules_config", fallback="config/rules.yaml")
        rules_path = Path(rules_file)
        if not rules_path.is_absolute():
            rules_path = PROJECT_ROOT / rules_path
        self.rules_file = str(rules_path)
        self.load_rules_config()

    def load_config(self):
        """加载配置文件"""
        if not Path(self.config_file).exists():
            logger.error(f"配置文件 {self.config_file} 不存在")
            sys.exit(1)

        self.config.read(self.config_file, encoding="utf-8")
        logger.info(f"已加载配置文件: {self.config_file}")

    def load_rules_config(self):
        """加载规则配置文件"""
        if not Path(self.rules_file).exists():
            logger.error(f"规则配置文件 {self.rules_file} 不存在")
            sys.exit(1)

        try:
            with open(self.rules_file, "r", encoding="utf-8") as f:
                self.rules_config = yaml.safe_load(f)
            logger.info(f"已加载规则配置文件: {self.rules_file}")
        except yaml.YAMLError as e:
            logger.error(f"规则配置文件格式错误: {e}")
            sys.exit(1)
        except Exception as e:
            logger.error(f"加载规则配置文件失败: {e}")
            sys.exit(1)

    def _get_active_provider(self) -> Optional[str]:
        """获取当前唯一启用的提供者（必填）。

        优先级：环境变量 ACTIVE_PROVIDER > [provider_control] active_provider。
        """
        env_value = os.environ.get("ACTIVE_PROVIDER")
        if env_value is not None and env_value.strip():
            return env_value.strip().upper()
        if self.config.has_section("provider_control"):
            value = self.config.get(
                "provider_control", "active_provider", fallback=""
            ).strip()
            if value:
                return value.upper()
        return None

    def get_proxy_providers(self) -> Dict[str, str]:
        """获取代理提供者配置（名称统一转为大写，只返回活动提供者）。"""
        providers = {}
        if "proxy_providers" in self.config:
            for name, url in self.config["proxy_providers"].items():
                providers[name.upper()] = url

        active = self._get_active_provider()
        if active is None:
            logger.error(
                "未配置 active_provider"
                "（请设置 [provider_control] active_provider 或环境变量 ACTIVE_PROVIDER）"
            )
            return {}

        if active not in providers:
            logger.error(
                f"active_provider 指定的提供者不存在: {active}"
                f"（可用的提供者: {sorted(providers)}）"
            )
            return {}
        logger.info(
            f"只使用提供者: {active}"
            f"（其他提供者不参与生成: {sorted(set(providers) - {active})}）"
        )
        return {active: providers[active]}

    def get_regions(self) -> Dict[str, Dict[str, Any]]:
        """获取地区配置（全部字段均为匹配关键词）"""
        regions = {}
        if "regions" in self.config:
            for region, config_str in self.config["regions"].items():
                keywords = [k.strip() for k in config_str.split(",") if k.strip()]
                if not keywords:
                    logger.warning(f"地区 {region} 未配置关键词，已跳过")
                    continue
                regions[region] = {"keywords": keywords}
        return regions

    def get_exclude_keywords(self) -> List[str]:
        """获取要排除的节点关键词"""
        exclude_keywords = []
        if "filter" in self.config:
            keywords_str = self.config.get("filter", "exclude_keywords", fallback="")
            if keywords_str:
                exclude_keywords = [k.strip() for k in keywords_str.split(",")]
        return exclude_keywords

    def _get_test_url(self) -> str:
        """获取测速 URL（缓存）"""
        if self._test_url_cache is None:
            self._test_url_cache = self.config.get(
                "clash",
                "test_url",
                fallback="http://connectivitycheck.gstatic.com/generate_204",
            )
        return self._test_url_cache

    def _get_group_type(self, region_name: str, default_type: str) -> str:
        """获取地区的代理组类型。

        优先级:
          [merged_regions] 地区键 > [merged_regions] default_type
          > [clash] group_type_{地区} > [clash] default_group_type
          > 硬编码默认值
        """
        if self.config.has_section("merged_regions"):
            if region_name != "default_type" and region_name in self.config["merged_regions"]:
                group_type = self.config["merged_regions"][region_name].strip()
                if group_type:
                    return group_type
            section_default = self.config.get(
                "merged_regions", "default_type", fallback=""
            ).strip()
            if section_default:
                return section_default

        if self.config.has_section("clash"):
            group_type = self.config.get(
                "clash", f"group_type_{region_name}", fallback=""
            ).strip()
            if group_type:
                return group_type
            clash_default = self.config.get(
                "clash", "default_group_type", fallback=""
            ).strip()
            if clash_default:
                return clash_default
        return default_type

    def fetch_subscription_nodes(self, url: str) -> List[Dict[str, Any]]:
        """直接拉取原始订阅链接并解析出节点列表。

        支持 base64 编码或明文的 Clash YAML（含 proxies 字段）。
        节点按名称去重；解析失败抛异常（由上层决定保留旧配置）。
        """
        logger.info(f"正在拉取订阅: {url[:60]}...")
        req = urllib.request.Request(
            url, headers={"User-Agent": "clash.meta", "Accept": "*/*"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            raise ValueError("订阅内容为空")

        # 候选内容：原文 + base64 解码（含 URL-safe 变体）
        candidates = [text]
        for variant in (text, text.replace("-", "+").replace("_", "/")):
            try:
                pad = "=" * (-len(variant) % 4)
                decoded = base64.b64decode(variant + pad).decode(
                    "utf-8", errors="replace"
                )
                if decoded not in candidates:
                    candidates.append(decoded)
            except Exception:
                continue

        proxies = None
        for candidate in candidates:
            try:
                data = yaml.safe_load(candidate)
                if isinstance(data, dict) and isinstance(data.get("proxies"), list):
                    proxies = data["proxies"]
                    break
                if isinstance(data, list):
                    proxies = data
                    break
            except Exception:
                continue
        if proxies is None:
            raise ValueError(
                "无法从订阅内容中解析出节点列表（未找到 proxies 字段）"
            )

        nodes = []
        seen = set()
        for proxy in proxies:
            if not isinstance(proxy, dict) or not proxy.get("name"):
                continue
            name = str(proxy["name"])
            if name in seen:
                continue
            seen.add(name)
            nodes.append(proxy)
        if not nodes:
            raise ValueError("订阅解析后没有可用节点")
        logger.info(f"订阅解析成功: {len(nodes)} 个节点")
        return nodes

    def _get_active_nodes(self) -> List[Dict[str, Any]]:
        """获取活动提供者的节点列表（进程内缓存，只拉取一次）。"""
        if self._nodes_cache is not None:
            return self._nodes_cache
        providers = self.get_proxy_providers()
        if not providers:
            raise ValueError("没有可用的活动提供者")
        url = next(iter(providers.values()))
        nodes = self.fetch_subscription_nodes(url)
        self._nodes_cache = nodes
        return nodes

    def _node_name_matches(self, name: str, keywords: List[str]) -> bool:
        """节点名是否包含任一关键词（子串匹配，与之前 filter 语义一致）。"""
        return any(kw in name for kw in keywords)

    def _is_excluded_node(self, name: str) -> bool:
        """节点名是否命中全局排除关键词（流量/到期等信息节点）。"""
        return any(kw in name for kw in self.get_exclude_keywords())

    def _usable_nodes(self, nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """过滤掉排除关键词命中的节点（信息节点不参与任何组）。"""
        return [n for n in nodes if not self._is_excluded_node(str(n.get("name", "")))]

    def _match_nodes(
        self, nodes: List[Dict[str, Any]], keywords: List[str]
    ) -> List[Dict[str, Any]]:
        """按关键词从可用节点池中筛选节点。"""
        return [
            n for n in nodes
            if self._node_name_matches(str(n.get("name", "")), keywords)
        ]

    def _create_proxy_group_config(
        self,
        name: str,
        group_type: str,
        proxies: List[str],
        test_url: str,
    ) -> Dict[str, Any]:
        """创建代理组配置的通用方法"""
        group_config = {
            "name": name,
            "type": group_type,
            "proxies": proxies,
            "url": test_url,
        }

        # 根据类型添加特定参数
        if group_type == "fallback":
            group_config["timeout"] = 5000
            group_config["interval"] = 60
        elif group_type == "url-test":
            group_config["tolerance"] = 500
            group_config["interval"] = 60
        elif group_type == "load-balance":
            group_config["strategy"] = "consistent-hashing"
            group_config["interval"] = 60

        return group_config

    def generate_region_groups(
        self, nodes: List[Dict[str, Any]], regions: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """生成地区组（每个地区一个组，显式列出匹配关键词的节点）"""
        region_groups = []
        test_url = self._get_test_url()
        default_type = self.config.get("clash", "default_group_type", fallback="fallback")
        usable = self._usable_nodes(nodes)

        for region_name, region_config in regions.items():
            keywords = region_config["keywords"]
            matched = self._match_nodes(usable, keywords)
            if not matched:
                logger.warning(f"地区 {region_name} 没有匹配到节点，跳过该地区组")
                continue
            group_type = self._get_group_type(region_name, default_type)

            group_config = self._create_proxy_group_config(
                name=region_name,
                group_type=group_type,
                proxies=[str(n["name"]) for n in matched],
                test_url=test_url,
            )
            region_groups.append(group_config)
            logger.info(
                f"创建地区组: {region_name} "
                f"(类型: {group_type}, 节点数: {len(matched)})"
            )

        logger.info(f"生成了 {len(region_groups)} 个地区组")
        return region_groups

    def generate_custom_groups(
        self, nodes: List[Dict[str, Any]], regions: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """生成自定义节点组"""
        custom_groups = []

        if not self.config.has_section("custom_groups"):
            return custom_groups

        test_url = self._get_test_url()
        usable = self._usable_nodes(nodes)

        # 遍历所有自定义组配置
        for group_name, config_str in self.config["custom_groups"].items():
            try:
                # 解析配置: 类型, 提供者列表, 地区列表, 目标代理组列表
                parts = [p.strip() for p in config_str.split(",")]
                if len(parts) < 3:
                    logger.warning(f"自定义组 {group_name} 配置不完整，跳过")
                    continue

                group_type = parts[0]
                # 提供者列表字段在单一供应商模式下不再参与匹配，仅占位解析
                providers_str = parts[1]
                regions_str = parts[2]
                target_groups_str = parts[3] if len(parts) > 3 else ""

                # 解析目标代理组列表
                if target_groups_str:
                    target_groups = [g.strip() for g in target_groups_str.split("|")]
                else:
                    target_groups = []  # 空表示添加到所有主代理组

                # 解析地区列表并筛选节点
                if regions_str:
                    selected_regions = [r.strip() for r in regions_str.split("|")]
                    keywords = []
                    for region_name in selected_regions:
                        if region_name in regions:
                            keywords.extend(regions[region_name]["keywords"])

                    if not keywords:
                        logger.warning(
                            f"自定义组 {group_name} 没有有效的地区关键词，跳过"
                        )
                        continue
                    matched = self._match_nodes(usable, keywords)
                    if not matched:
                        logger.warning(f"自定义组 {group_name} 没有匹配到节点，跳过")
                        continue
                else:
                    logger.warning(f"自定义组 {group_name} 没有指定地区，跳过")
                    continue

                # 创建自定义组配置（组名直接使用配置中的名称）
                group_config = self._create_proxy_group_config(
                    name=group_name,
                    group_type=group_type,
                    proxies=[str(n["name"]) for n in matched],
                    test_url=test_url,
                )

                # 保存目标代理组信息（用于后续添加到主代理组）
                group_config["_target_groups"] = target_groups

                custom_groups.append(group_config)
                target_info = (
                    f"目标组: {','.join(target_groups)}"
                    if target_groups
                    else "目标组: 所有"
                )
                logger.info(
                    f"创建自定义节点组: {group_name} "
                    f"(类型: {group_type}, 节点数: {len(matched)}, "
                    f"地区: {regions_str}, {target_info})"
                )

            except Exception as e:
                logger.error(f"解析自定义组 {group_name} 配置失败: {e}")
                continue

        if custom_groups:
            logger.info(f"生成了 {len(custom_groups)} 个自定义节点组")

        return custom_groups

    def _get_region_group_names(
        self,
        nodes: List[Dict[str, Any]],
        regions: Dict[str, Dict[str, Any]],
    ) -> List[str]:
        """获取所有实际会生成的地区组名称（只保留匹配到节点的地区）"""
        region_group_names = []
        usable = self._usable_nodes(nodes)
        for region_name, region_config in regions.items():
            if self._match_nodes(usable, region_config["keywords"]):
                region_group_names.append(region_name)
        return region_group_names

    def generate_relay_group(
        self, nodes: List[Dict[str, Any]], regions: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """生成中继代理组，包含所有已生成地区的地区组"""
        relay_groups = []

        # 检查是否有中继组配置（空节视为未启用）
        if not self.config.has_section("relay_groups") or not self.config.items(
            "relay_groups"
        ):
            return relay_groups

        test_url = self._get_test_url()

        # 获取中继组配置
        relay_name = self.config.get("relay_groups", "name", fallback="统一代理")
        relay_type = self.config.get("relay_groups", "type", fallback="fallback")

        # 获取要包含的地区列表，如果未指定则包含所有地区
        included_regions_str = self.config.get("relay_groups", "regions", fallback="")
        if included_regions_str:
            included_regions = [r.strip() for r in included_regions_str.split(",")]
        else:
            included_regions = list(regions.keys())

        # 创建中继组，使用实际存在的地区组作为节点
        existing_region_names = self._get_region_group_names(nodes, regions)
        proxies = []
        for region_name in included_regions:
            if region_name not in existing_region_names:
                continue
            proxies.append(region_name)

        if not proxies:
            logger.warning("中继组没有可用的节点，跳过生成")
            return relay_groups

        # 检查是否有为中继组配置默认节点
        proxy_defaults = {}
        if self.config.has_section("proxy_group_defaults"):
            for group_name, default_node in self.config["proxy_group_defaults"].items():
                if default_node:
                    proxy_defaults[group_name] = default_node

        # 创建中继组配置
        relay_group_config = {
            "name": relay_name,
            "type": relay_type,
            "proxies": proxies,  # 使用合并的地区组作为节点
            "url": test_url,
        }

        # 如果为中继组配置了默认节点，将其放在proxies的第一个位置
        if relay_name in proxy_defaults:
            default_node = proxy_defaults[relay_name]
            if default_node in proxies:
                # 将默认节点移到列表开头
                proxies.remove(default_node)
                proxies.insert(0, default_node)
                relay_group_config["proxies"] = proxies
                logger.info(f"为中继组 {relay_name} 设置默认节点: {default_node}")
            else:
                logger.warning(
                    f"为中继组 {relay_name} 配置的默认节点 {default_node} 不存在于可用节点列表中"
                )

        # 根据类型添加特定参数
        if relay_type == "fallback":
            relay_group_config["timeout"] = 5000
            relay_group_config["interval"] = 60
        elif relay_type == "url-test":
            relay_group_config["tolerance"] = 100
            relay_group_config["interval"] = 30
        elif relay_type == "load-balance":
            relay_group_config["strategy"] = "consistent-hashing"
            relay_group_config["interval"] = 60

        relay_groups.append(relay_group_config)
        logger.info(
            f"创建中继组: {relay_name} (类型: {relay_type}, 包含 {len(proxies)} 个节点)"
        )

        return relay_groups

    def _should_include_relay_group(self, group_name: str) -> bool:
        """判断是否应该将中继组添加到当前主代理组"""
        include_relay = True  # 默认添加到所有主代理组

        if self.config.has_section("relay_groups_targets"):
            # 如果配置了目标组列表，则只在指定的组中添加中继组
            target_groups_str = self.config.get(
                "relay_groups_targets", group_name, fallback=""
            )
            if target_groups_str:
                include_relay = True
            else:
                include_relay = False

        return include_relay

    def generate_main_proxy_groups(
        self,
        nodes: List[Dict[str, Any]],
        regions: Dict[str, Dict[str, Any]],
        custom_groups: List[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """生成主要代理组"""
        if custom_groups is None:
            custom_groups = []

        # 获取所有地区组名称
        region_group_names = self._get_region_group_names(
            nodes, regions
        )
        # 全部可用节点名称（逐个单独加入每个主组）
        all_node_names = [str(n["name"]) for n in self._usable_nodes(nodes)]

        # 获取代理组默认配置
        proxy_defaults = {}
        if self.config.has_section("proxy_group_defaults"):
            for group_name, default_node in self.config["proxy_group_defaults"].items():
                if default_node:
                    proxy_defaults[group_name] = default_node
                    logger.info(f"读取默认节点配置: {group_name} -> {default_node}")

        # 获取主代理组的自定义地区配置
        custom_region_groups = {}
        if self.config.has_section("main_proxy_region_groups"):
            for group_name, regions_str in self.config[
                "main_proxy_region_groups"
            ].items():
                region_list = [r.strip() for r in regions_str.split(",")]
                custom_region_groups[group_name] = region_list
                logger.info(f"设置 {group_name} 的自定义地区组: {region_list}")

        # 获取中继组名称（如果配置了）
        relay_group_name = None
        if self.config.has_section("relay_groups"):
            relay_group_name = self.config.get(
                "relay_groups", "name", fallback="统一代理"
            )

        # 从配置文件获取代理组配置
        proxy_groups_config = self.rules_config.get("proxy_groups", {})
        main_groups = []

        # 处理主要代理组
        main_groups_config = proxy_groups_config.get("main_groups", [])
        for group_config in main_groups_config:
            group_name = group_config["name"]

            # 构建 proxies 列表：默认节点（如果有） + 地区组 + 自定义组 + 中继组 + DIRECT
            proxies = []
            default_node = proxy_defaults.get(group_name, None)

            # 添加默认节点（如果配置了）
            if default_node:
                proxies.append(default_node)

            # 根据自定义配置或默认行为添加地区组
            if group_name in custom_region_groups:
                region_list = custom_region_groups[group_name]

                # 检查是否为手动模式
                if len(region_list) == 1 and region_list[0].lower() == "manual":
                    logger.info(
                        f"主代理组 {group_name} 设置为手动模式，不自动添加任何地区节点"
                    )
                else:
                    # 使用自定义地区组（只添加实际存在的组，避免悬空引用）
                    for region_name, region_config in regions.items():
                        if (
                            region_name not in region_list
                            or region_name not in region_group_names
                        ):
                            continue
                        full_region_name = region_name
                        if (
                            full_region_name != default_node
                            and full_region_name not in proxies
                        ):
                            proxies.append(full_region_name)
            else:
                # 默认行为：添加所有地区组（排除已作为默认节点的）
                for region_name in region_group_names:
                    if region_name != default_node and region_name not in proxies:
                        proxies.append(region_name)

            # 添加自定义组（根据目标组过滤，排除已作为默认节点的）
            for custom_group in custom_groups:
                custom_group_name = custom_group["name"]
                target_groups = custom_group.get("_target_groups", [])

                # 如果目标组为空（表示添加到所有主代理组）或包含当前组
                if (
                    not target_groups or group_name in target_groups
                ) and custom_group_name != default_node:
                    if custom_group_name not in proxies:
                        proxies.append(custom_group_name)

            # 检查当前主代理组是否将中继组作为默认节点
            if (
                relay_group_name
                and default_node == relay_group_name
                and relay_group_name not in proxies
            ):
                proxies.insert(0, relay_group_name)  # 插入到开头以确保是默认节点

            # 添加中继组（如果配置了且不是默认节点，并且不在proxies中）
            if (
                relay_group_name
                and relay_group_name != default_node
                and relay_group_name not in proxies
            ):
                if self._should_include_relay_group(group_name):
                    proxies.append(relay_group_name)

            # 逐个追加全部可用节点（每个节点单独出现在该策略组中）
            for node_name in all_node_names:
                if node_name != default_node and node_name not in proxies:
                    proxies.append(node_name)

            # 最后添加 DIRECT
            if "DIRECT" != default_node and "DIRECT" not in proxies:
                proxies.append("DIRECT")

            group = {
                "name": group_name,
                "type": group_config["type"],
                "proxies": proxies,
            }
            main_groups.append(group)

        # 处理特殊代理组（不使用代理提供商）
        special_groups_config = proxy_groups_config.get("special_groups", [])
        for group_config in special_groups_config:
            group = {
                "name": group_config["name"],
                "type": group_config["type"],
                "proxies": group_config["proxies"],
            }
            main_groups.append(group)

        return main_groups

    def get_rule_providers(self) -> Dict[str, Any]:
        """获取规则集配置"""
        return self.rules_config.get("rule-providers", {})

    def get_custom_rules(self) -> List[str]:
        """获取自定义规则"""
        rules = []

        # 获取自定义规则配置
        custom_rules = self.rules_config.get("custom_rules", [])
        if isinstance(custom_rules, list):
            rules.extend(custom_rules)

        # 添加规则集引用规则
        ruleset_rules = self.rules_config.get("ruleset_rules", [])
        rules.extend(ruleset_rules)

        return rules

    def _generate_all_proxy_groups(
        self, nodes: List[Dict[str, Any]], regions: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """根据配置生成所有代理组"""
        # 先生成中继组，放在最前面
        relay_groups = self.generate_relay_group(nodes, regions)

        # 生成自定义组
        custom_groups = self.generate_custom_groups(nodes, regions)

        # 生成地区组（每个地区一个组）
        region_groups = self.generate_region_groups(nodes, regions)

        # 生成主代理组（内部逐个列出全部节点）
        main_groups = self.generate_main_proxy_groups(nodes, regions, custom_groups)

        # 生成所有代理组 - 按顺序添加：中继组、主代理组、地区组、自定义组
        all_groups = []
        if relay_groups:
            all_groups.extend(relay_groups)
        all_groups.extend(main_groups)
        all_groups.extend(region_groups)
        all_groups.extend(
            [
                # 添加自定义组，移除内部使用的 _target_groups 字段
                {k: v for k, v in custom_group.items() if not k.startswith("_")}
                for custom_group in custom_groups
            ]
        )
        return all_groups

    def generate_config(self) -> Dict[str, Any]:
        """生成完整的 Clash 配置"""
        providers = self.get_proxy_providers()
        regions = self.get_regions()

        if not providers:
            logger.error("没有配置代理提供者")
            return {}

        logger.info(f"找到 {len(providers)} 个代理提供者: {list(providers.keys())}")
        logger.info(f"找到 {len(regions)} 个地区配置: {list(regions.keys())}")

        # 直接拉取活动提供者的原始订阅并解析节点（失败则终止，保留旧配置）
        nodes = self._get_active_nodes()

        # 生成配置
        config = {
            "port": self.config.getint("clash", "port", fallback=7890),
            "socks-port": self.config.getint("clash", "socks_port", fallback=7891),
            "allow-lan": self.config.getboolean("clash", "allow_lan", fallback=True),
            "mode": self.config.get("clash", "mode", fallback="Rule"),
            "log-level": self.config.get("clash", "log_level", fallback="info"),
            "external-controller": self.config.get(
                "clash", "external_controller", fallback=":9090"
            ),
            "proxies": self._usable_nodes(nodes),
            "proxy-groups": self._generate_all_proxy_groups(nodes, regions),
            "rule-providers": self.get_rule_providers(),
            "rules": self.get_custom_rules(),
        }

        return config

    def validate_generated_config(
        self, config: Dict[str, Any]
    ) -> Tuple[bool, List[str]]:
        """生成前校验：组名唯一、引用完整、类型合法、正则有效、规则格式正确。

        返回 (是否通过, 错误列表)。校验失败时不应覆盖旧配置。
        """
        errors: List[str] = []
        groups = config.get("proxy-groups", [])
        group_names: List[str] = []
        for group in groups:
            name = group.get("name", "")
            if not name:
                errors.append("存在名称为空的代理组")
            elif name in group_names:
                errors.append(f"代理组名称重复: {name}")
            else:
                group_names.append(name)
        name_set = set(group_names)
        node_names = {str(p.get("name", "")) for p in config.get("proxies", [])}

        for group in groups:
            gname = group.get("name", "?")
            for proxy in group.get("proxies", []):
                if (
                    proxy not in BUILTIN_PROXIES
                    and proxy not in name_set
                    and proxy not in node_names
                ):
                    errors.append(f"代理组 {gname} 引用了不存在的节点或组: {proxy}")
            gtype = group.get("type", "")
            if gtype not in VALID_GROUP_TYPES:
                errors.append(f"代理组 {gname} 使用了无效类型: {gtype or '(空)'}")

        for rule in config.get("rules", []):
            fields = [part.strip() for part in str(rule).split(",")]
            rule_type = fields[0]
            if rule_type not in VALID_RULE_TYPES:
                errors.append(f"未知规则类型: {rule}")
                continue
            if len(fields) < 2:
                errors.append(f"规则格式不完整: {rule}")
                continue
            if rule_type == "MATCH":
                target = fields[1]
            else:
                target = fields[2] if len(fields) >= 3 else None
            if target is None:
                errors.append(f"规则缺少目标代理组: {rule}")
            elif target not in name_set and target not in BUILTIN_PROXIES:
                errors.append(f"规则指向不存在的代理组 '{target}': {rule}")

        return (not errors, errors)

    def save_config(
        self, config: Dict[str, Any], output_file: Optional[str] = None
    ) -> bool:
        """保存配置：先备份旧文件，再原子写入，最后输出统计信息。"""
        try:
            start = time.monotonic()
            if output_file is None:
                output_file = str(PROJECT_ROOT / "output" / "clash_profile.yaml")
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)

            # 备份旧配置（失败不阻断生成，仅告警）
            backup_dir = PROJECT_ROOT / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            if output_path.exists():
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup_file = backup_dir / f"clash_profile_{stamp}.yaml"
                try:
                    shutil.copy2(output_path, backup_file)
                    logger.info(f"已备份旧配置: {backup_file.name}")
                except OSError as e:
                    logger.warning(f"备份旧配置失败: {e}")

                # 清理超出保留数量的备份
                backup_keep = self.config.getint("server", "backup_keep", fallback=10)
                backups = sorted(
                    backup_dir.glob("clash_profile_*.yaml"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                for old_backup in backups[backup_keep:]:
                    try:
                        old_backup.unlink()
                        logger.info(f"清理旧备份: {old_backup.name}")
                    except OSError as e:
                        logger.warning(f"清理备份 {old_backup.name} 失败: {e}")

            # 原子写入：先写临时文件，再替换
            tmp_path = output_path.with_name(output_path.name + ".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                yaml.dump(
                    config,
                    f,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                )
            os.replace(tmp_path, output_path)

            file_size = output_path.stat().st_size
            logger.info(f" 配置文件已生成: {output_path}")
            logger.info(f" 文件大小: {file_size} 字节")
            logger.info(f" 代理组数量: {len(config.get('proxy-groups', []))}")
            logger.info(f" 规则数量: {len(config.get('rules', []))}")

            # 输出统计信息（供 Web 状态页展示）
            stats = {
                "generated_at": datetime.now().isoformat(timespec="seconds"),
                "providers": 1 if config.get("proxies") else 0,
                "providers_total": (
                    len(self.config["proxy_providers"])
                    if self.config.has_section("proxy_providers")
                    else 0
                ),
                "nodes": len(config.get("proxies", [])),
                "regions": len(self.get_regions()),
                "groups": len(config.get("proxy-groups", [])),
                "rules": len(config.get("rules", [])),
                "duration_ms": round((time.monotonic() - start) * 1000),
            }
            stats_path = PROJECT_ROOT / "output" / "stats.json"
            with open(stats_path, "w", encoding="utf-8") as f:
                json.dump(stats, f, ensure_ascii=False, indent=2)

            return True
        except Exception as e:
            logger.error(f"保存配置文件失败: {e}")
            return False

    def run(self) -> bool:
        """运行生成器"""
        start = time.monotonic()
        logger.info(" 开始生成 Clash 配置")
        logger.info("=" * 50)

        config = self.generate_config()
        if not config:
            logger.error(" 配置生成失败")
            return False

        ok, errors = self.validate_generated_config(config)
        if not ok:
            logger.error(
                f" 配置未通过校验（{len(errors)} 个问题），保留现有配置文件"
            )
            for err in errors:
                logger.error(f"  - {err}")
            return False

        if self.save_config(config):
            logger.info(f" 配置生成完成! 总耗时 {time.monotonic() - start:.1f}s")
            return True
        else:
            logger.error(" 配置保存失败")
            return False


def main():
    """主函数"""
    generator = ClashConfigGenerator()
    success = generator.run()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
