#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clash 配置生成器 - 主入口脚本
"""

import sys
import os
from pathlib import Path

# 添加 src 目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent / "src"))

from generate_clash_config import main

if __name__ == "__main__":
    main()
