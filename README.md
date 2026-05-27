# dokploy-safe-mcp

Single MCP entry point for this Dokploy host.

It includes safe deployment tools plus common Dokploy inspection and management tools, so users can usually configure only this MCP instead of also configuring `@dokploy/mcp`.

Core safe tools:

- `dokploy_platform_rules`
- `dokploy_connection_check`
- `dokploy_deploy_static_page`
- `dokploy_publish_route`

Common Dokploy tools included:

- project list/detail/create
- environment list/create
- application search/detail/deploy/logs
- compose search/detail/create/update/deploy/deployments/logs

The safe deployment tools always use the public entry `http://183.196.108.32:18080`, publish routes through `/join/routes`, and verify the final public URL returns 200.

## Recommended Codex Config

Users do not need to download this folder manually. Add this single MCP server to Codex config and replace the API key:

```toml
[mcp_servers.dokploy_safe]
command = "npx"
args = ["-y", "github:wenRou21/dokploy-safe-mcp"]
enabled = true
startup_timeout_sec = 180

[mcp_servers.dokploy_safe.env]
DOKPLOY_URL = "http://183.196.108.32:18080"
DOKPLOY_PUBLIC_HTTP_URL = "http://183.196.108.32:18080"
DOKPLOY_API_KEY = "<YOUR_DOKPLOY_API_KEY>"
```

Then restart Codex completely.

## Prompt Template

```text
Please configure Dokploy safe MCP for Codex.

MCP package:
github:wenRou21/dokploy-safe-mcp

My Dokploy API Key:
<YOUR_DOKPLOY_API_KEY>

Add this MCP to Codex config:
- MCP name: dokploy_safe
- command: npx
- args: ["-y", "github:wenRou21/dokploy-safe-mcp"]
- startup_timeout_sec: 180
- DOKPLOY_URL: http://183.196.108.32:18080
- DOKPLOY_PUBLIC_HTTP_URL: http://183.196.108.32:18080
- DOKPLOY_API_KEY: use the key above

After configuration, remind me to fully restart Codex. After restart, check Dokploy connectivity and list projects, applications, compose, and dokploy_safe tools.
```

## Local Install

If this repository is already downloaded locally, the installer can update Codex config.

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -ApiKey "<YOUR_DOKPLOY_API_KEY>"
```

Linux/macOS:

```bash
chmod +x ./install-codex.sh
./install-codex.sh "<YOUR_DOKPLOY_API_KEY>"
```
