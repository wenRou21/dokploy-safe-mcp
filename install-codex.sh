#!/usr/bin/env bash
set -euo pipefail

API_KEY="${1:-}"
MCP_NAME="${MCP_NAME:-dokploy_safe}"
DOKPLOY_URL="${DOKPLOY_URL:-http://183.196.108.32:18080}"
PUBLIC_HTTP_URL="${DOKPLOY_PUBLIC_HTTP_URL:-http://183.196.108.32:18080}"

if [ -z "$API_KEY" ]; then
	echo "Usage: ./install-codex.sh <DOKPLOY_API_KEY>" >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js was not found in PATH. Install Node.js first." >&2
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "npm was not found in PATH. Install npm first." >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PATH="$SCRIPT_DIR/server.mjs"
CONFIG_DIR="$HOME/.codex"
CONFIG_PATH="$CONFIG_DIR/config.toml"

cd "$SCRIPT_DIR"
if [ ! -d node_modules ]; then
	npm install
fi

mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_PATH" ]; then
	cp "$CONFIG_PATH" "$CONFIG_PATH.bak-$MCP_NAME-$(date +%Y%m%d%H%M%S)"
fi

python3 - "$CONFIG_PATH" "$MCP_NAME" "$SERVER_PATH" "$DOKPLOY_URL" "$PUBLIC_HTTP_URL" "$API_KEY" <<'PY'
import re
import sys
from pathlib import Path

config_path, mcp_name, server_path, dokploy_url, public_http_url, api_key = sys.argv[1:]
path = Path(config_path)
content = path.read_text(encoding="utf-8") if path.exists() else ""
escaped_server = server_path.replace("\\", "\\\\")

block = f"""
[mcp_servers.{mcp_name}]
command = "node"
args = ["{escaped_server}"]
enabled = true
startup_timeout_sec = 120

[mcp_servers.{mcp_name}.env]
DOKPLOY_URL = "{dokploy_url}"
DOKPLOY_PUBLIC_HTTP_URL = "{public_http_url}"
DOKPLOY_API_KEY = "{api_key}"
""".strip()

for suffix in ("", ".env"):
	pattern = rf"(?ms)^\[mcp_servers\.{re.escape(mcp_name + suffix)}\]\n.*?(?=^\[|\Z)"
	content = re.sub(pattern, "", content).rstrip()

path.write_text(content + "\n\n" + block + "\n", encoding="utf-8")
PY

echo "Installed $MCP_NAME MCP into $CONFIG_PATH"
echo "MCP server path: $SERVER_PATH"
echo "Restart Codex completely, then ask Codex to use dokploy_deploy_static_page."
