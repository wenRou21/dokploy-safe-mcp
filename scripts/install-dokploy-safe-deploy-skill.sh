#!/usr/bin/env bash
set -euo pipefail

repo_raw_base="${DOKPLOY_SAFE_MCP_RAW_BASE:-https://raw.githubusercontent.com/wenRou21/dokploy-safe-mcp/main}"
skill_root="${CODEX_HOME:-$HOME/.codex}/skills/dokploy-safe-deploy"

mkdir -p "$skill_root/agents"

curl -fsSL "$repo_raw_base/skills/dokploy-safe-deploy/SKILL.md" -o "$skill_root/SKILL.md"
curl -fsSL "$repo_raw_base/skills/dokploy-safe-deploy/agents/openai.yaml" -o "$skill_root/agents/openai.yaml"

echo "dokploy-safe-deploy skill installed at $skill_root"
