# dokploy-safe-mcp

Single MCP entry point for this Dokploy host.

It includes safe deployment tools plus the upstream Dokploy OpenAPI tools, so users can usually configure only this MCP instead of also configuring `@dokploy/mcp`.

Core safe tools:

- `dokploy_platform_rules`
- `dokploy_connection_check`
- `dokploy_deploy_static_page`
- `dokploy_publish_route`
- `dokploy_prepare_upload_slot`
- `dokploy_deploy_from_local_archive`

Common Dokploy tools included:

- project list/detail/create
- environment list/create
- application search/detail/deploy/logs
- compose search/detail/create/update/deploy/deployments/logs

Full upstream Dokploy API access is also available through `raw_*` tools, for example `raw_project_all`, `raw_compose_update`, and `raw_application_deploy`. Safe deployment tools should still be preferred for public route publishing.

For clients that cannot handle a very large tool list, set `DOKPLOY_ENABLED_TAGS` to a comma-separated tag list such as `project,environment,application,compose,deployment`. Safe tools are always included.

The safe deployment tools always use the public entry `http://183.196.108.32:18080`, publish routes through `/join/routes`, and verify the final public URL returns 200.

## Local Project Uploads

For real projects that are too large to embed into MCP JSON, use:

- `dokploy_prepare_upload_slot`: returns the configured HTTP upload gateway and size limit.
- `dokploy_deploy_from_local_archive`: accepts a local directory or archive, uploads it to the Dokploy host over HTTP multipart, creates a raw Dokploy compose, deploys it, publishes a `/join/routes` path, and verifies HTTP 200.

The upload gateway accepts the archive and returns a deployment task immediately; the MCP then polls the task status until the server-side Dokploy deployment and public URL verification finish. This avoids long-lived upload HTTP requests during large builds.

Supported `dokploy_deploy_from_local_archive` modes:

- `static`: serve uploaded static files through `nginx:alpine`.
- `dockerfile`: build an uploaded `Dockerfile`.
- `auto`: let the upload gateway choose Dockerfile, static, Node, or Python templates.
- `railpack`: reserved for future Railpack/Nixpacks integration; currently returns a clear server-side error if unavailable.

The machine running Codex/MCP must have `tar` available for directory uploads. Optional upload settings:

```toml
[mcp_servers.dokploy_safe.env]
DOKPLOY_UPLOAD_URL = "http://183.196.108.32:18080/join/deployments"
DOKPLOY_UPLOAD_MAX_MB = "500"
```

If these are omitted, the MCP defaults to `${DOKPLOY_PUBLIC_HTTP_URL}/join/deployments` and a 500MB upload limit. SSH/SCP is no longer required for normal users.

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
