#!/usr/bin/env bash
# opencode onprem bundle 环境配置
# 用法: source env.sh

export OPENCODE_ONPREM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$OPENCODE_ONPREM_DIR/bin:$PATH"

# 禁用所有网络相关功能
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true

echo "[opencode onprem] loaded from $OPENCODE_ONPREM_DIR"
