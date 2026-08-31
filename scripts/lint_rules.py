#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clash 规则文件 lint 工具

检查 config/rules.yaml 中的常见问题：
  - 完全重复的规则行（error）
  - 被其他网段包含的 CIDR（error，冗余）
  - 部分重叠的 CIDR（warning，可能有意为之）
  - DOMAIN-SUFFIX 中的无效 "*. " 前缀（error）
  - 规则行逗号后带空格（warning，风格问题）
  - 未知规则类型（error）
  - 规则目标代理组不存在（error）
  - 同一域名被路由到不同代理组（warning，可能存在冲突）

用法:
  python scripts/lint_rules.py [rules.yaml]
退出码: 0=通过(仅 warning 也视为通过), 1=存在 error
"""

import argparse
import ipaddress
import re
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

import yaml


BUILTIN_PROXIES = {"DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"}

VALID_RULE_TYPES = {
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX",
    "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE",
    "SRC-IP-CIDR", "SRC-PORT", "DST-PORT", "SRC-IP-ASN",
    "PROCESS-NAME", "PROCESS-PATH", "RULE-SET", "MATCH",
    "AND", "OR", "NOT", "SUB-RULE",
}


def load_rules(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError("rules.yaml 顶层必须是映射")
    return data


def collect_group_names(data: dict) -> Set[str]:
    """收集所有代理组名称（主代理组 + 特殊代理组）。"""
    names: Set[str] = set()
    proxy_groups = data.get("proxy_groups", {}) or {}
    for key in ("main_groups", "special_groups"):
        for group in proxy_groups.get(key, []) or []:
            if isinstance(group, dict) and group.get("name"):
                names.add(group["name"])
    return names


def parse_rule(rule: str) -> Tuple[str, List[str]]:
    fields = [part.strip() for part in rule.split(",")]
    return fields[0], fields


def rule_target(rule_type: str, fields: List[str]) -> str | None:
    if rule_type == "MATCH":
        return fields[1] if len(fields) >= 2 else None
    return fields[2] if len(fields) >= 3 else None


def lint(path: Path) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []

    data = load_rules(path)
    group_names = collect_group_names(data)

    all_rules: List[str] = []
    all_rules.extend(data.get("custom_rules", []) or [])
    all_rules.extend(data.get("ruleset_rules", []) or [])

    # 1. 完全重复
    seen: Dict[str, int] = {}
    for rule in all_rules:
        rule = rule.strip()
        seen[rule] = seen.get(rule, 0) + 1
    for rule, count in seen.items():
        if count > 1:
            errors.append(f"完全重复的规则行（{count} 次）: {rule}")

    # 2. CIDR 包含/重叠
    cidr_rules: List[Tuple[str, str, str]] = []  # (rule, cidr, group)
    for rule in all_rules:
        rule_type, fields = parse_rule(rule)
        if rule_type in ("IP-CIDR", "IP-CIDR6") and len(fields) >= 3:
            cidr_rules.append((rule, fields[1], fields[2]))
    for i, (rule_a, cidr_a, group_a) in enumerate(cidr_rules):
        try:
            net_a = ipaddress.ip_network(cidr_a, strict=False)
        except ValueError:
            errors.append(f"无效 CIDR: {cidr_a}（{rule_a}）")
            continue
        for rule_b, cidr_b, group_b in cidr_rules[i + 1:]:
            if group_a != group_b:
                continue
            try:
                net_b = ipaddress.ip_network(cidr_b, strict=False)
            except ValueError:
                errors.append(f"无效 CIDR: {cidr_b}（{rule_b}）")
                continue
            if net_a.version != net_b.version:
                continue
            if net_a.subnet_of(net_b) and net_a != net_b:
                errors.append(f"CIDR 冗余（{cidr_a} 已被 {cidr_b} 包含）: {rule_a}")
            elif net_b.subnet_of(net_a) and net_a != net_b:
                errors.append(f"CIDR 冗余（{cidr_b} 已被 {cidr_a} 包含）: {rule_b}")
            elif net_a.overlaps(net_b):
                warnings.append(f"CIDR 部分重叠: {cidr_a} <-> {cidr_b}")

    # 3. 规则格式与目标组
    domain_targets: Dict[str, Set[str]] = {}
    for rule in all_rules:
        rule_type, fields = parse_rule(rule)
        if rule_type not in VALID_RULE_TYPES:
            errors.append(f"未知规则类型: {rule}")
            continue
        if rule_type == "DOMAIN-SUFFIX" and len(fields) >= 2 and fields[1].startswith("*."):
            errors.append(f"DOMAIN-SUFFIX 无需 '*. ' 前缀: {rule}")
        if rule_type in ("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD") and len(fields) >= 3:
            domain_targets.setdefault(f"{rule_type}:{fields[1]}", set()).add(fields[2])
        if len(fields) < 2:
            errors.append(f"规则格式不完整: {rule}")
            continue
        target = rule_target(rule_type, fields)
        if target is None:
            errors.append(f"规则缺少目标代理组: {rule}")
        elif target not in group_names and target not in BUILTIN_PROXIES:
            errors.append(f"规则指向不存在的代理组 '{target}': {rule}")
        if re.search(r",\s", rule):
            warnings.append(f"规则逗号后带空格（建议去掉）: {rule}")

    # 4. 同一规则目标路由到不同组（冲突提示）
    for key, targets in sorted(domain_targets.items()):
        if len(targets) > 1:
            warnings.append(f"同一规则目标被路由到多个组 {sorted(targets)}: {key}")

    return errors, warnings


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Clash 规则文件 lint")
    parser.add_argument("rules_file", nargs="?", default="config/rules.yaml")
    args = parser.parse_args()
    path = Path(args.rules_file)
    if not path.exists():
        print(f"文件不存在: {path}")
        return 2
    try:
        errors, warnings = lint(path)
    except Exception as e:
        print(f"解析失败: {e}")
        return 2

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    print(f"\n检查完成: {len(errors)} 个错误, {len(warnings)} 个警告")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
