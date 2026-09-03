#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Clash 规则公共常量与解析/校验工具。

供配置生成器（src/generate_clash_config.py）与规则 lint 脚本
（scripts/lint_rules.py）共用，避免校验逻辑两处维护导致漂移。
"""

from typing import List, Optional, Set, Tuple

# Clash 内置的代理关键字（引用检查时无需匹配代理组/节点）
BUILTIN_PROXIES = {"DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"}

# 允许的规则类型（用于基础校验）
VALID_RULE_TYPES = {
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX",
    "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE",
    "SRC-IP-CIDR", "SRC-PORT", "DST-PORT", "SRC-IP-ASN",
    "PROCESS-NAME", "PROCESS-PATH", "RULE-SET", "MATCH",
    "AND", "OR", "NOT", "SUB-RULE",
}


def parse_rule(rule: str) -> Tuple[str, List[str]]:
    """把规则行拆成 (规则类型, 字段列表)，每个字段去掉首尾空白。"""
    fields = [part.strip() for part in str(rule).split(",")]
    return fields[0], fields


def rule_target(rule_type: str, fields: List[str]) -> Optional[str]:
    """返回规则指向的代理组（MATCH 在第 2 列，其余规则在第 3 列）。"""
    if rule_type == "MATCH":
        return fields[1] if len(fields) >= 2 else None
    return fields[2] if len(fields) >= 3 else None


def check_rule(rule: str, valid_groups: Set[str]) -> Optional[str]:
    """校验单条规则的类型、格式与目标代理组，合法返回 None，否则返回错误信息。"""
    rule_type, fields = parse_rule(rule)
    if rule_type not in VALID_RULE_TYPES:
        return f"未知规则类型: {rule}"
    if len(fields) < 2:
        return f"规则格式不完整: {rule}"
    target = rule_target(rule_type, fields)
    if target is None:
        return f"规则缺少目标代理组: {rule}"
    if target not in valid_groups and target not in BUILTIN_PROXIES:
        return f"规则指向不存在的代理组 '{target}': {rule}"
    return None
