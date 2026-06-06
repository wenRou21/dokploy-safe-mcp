# dokploy-safe-mcp

Single MCP entry point for this Dokploy host.

It includes high-level deployment workflow tools plus the upstream Dokploy OpenAPI tools, so users can usually configure only this MCP instead of also configuring `@dokploy/mcp`.

Core safe tools:

- `dokploy_platform_rules`
- `dokploy_connection_check`
- `dokploy_deploy_static_page`
- `dokploy_publish_route`
- `dokploy_unpublish_route`
- `dokploy_prepare_upload_slot`
- `dokploy_deploy_from_local_archive`
- `dokploy_get_project_status`
- `dokploy_delete_project`
- `dokploy_cleanup_failed_deploy`

Common Dokploy tools included:

- project list/detail/create
- environment list/create
- application search/detail/deploy/logs
- compose search/detail/create/update/deploy/deployments/logs

Full upstream Dokploy API access is also available through `raw_*` tools, for example `raw_project_all`, `raw_compose_update`, and `raw_application_deploy`. These are intended for administrator troubleshooting. Normal user workflows should prefer `dokploy_deploy_from_local_archive`, `dokploy_get_project_status`, `dokploy_delete_project`, and `dokploy_cleanup_failed_deploy`.

For clients that cannot handle a very large tool list, set `DOKPLOY_ENABLED_TAGS` to a comma-separated tag list such as `project,environment,application,compose,deployment`. Safe tools are always included.

The safe deployment tools always use the public entry `http://183.196.108.32:18080`, publish/remove routes through `/join/routes`, and verify the final public URL state.

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
DOKPLOY_UPLOAD_STATUS_URL = "http://183.196.108.32:18080/join/deployments"
DOKPLOY_ROUTES_URL = "http://183.196.108.32:18080/join/routes"
DOKPLOY_UPLOAD_MAX_MB = "500"
DOKPLOY_COMPOSE_ROOT = "/etc/dokploy/compose"
```

If these are omitted, the MCP defaults to `${DOKPLOY_PUBLIC_HTTP_URL}/join/deployments` and a 500MB upload limit. SSH/SCP is no longer required for normal users.

When testing on the Dokploy host itself, operators can point `DOKPLOY_URL`, `DOKPLOY_UPLOAD_URL`, `DOKPLOY_UPLOAD_STATUS_URL`, and `DOKPLOY_ROUTES_URL` at local Traefik (`http://127.0.0.1`) while keeping `DOKPLOY_PUBLIC_HTTP_URL` public for final route verification.

## Project Deletion and Cleanup

Use the high-level tools before raw API calls:

- `dokploy_get_project_status`: inspect one project, related compose apps, deployments, managed routes, and route checks.
- `dokploy_delete_project`: delete one visible project by exact ID or unique name, remove its managed routes, and clean up leftover containers.
- `dokploy_cleanup_failed_deploy`: clean up failed or partial deployments by project, compose, or route path.

Project names must resolve to exactly one visible project. If a name matches multiple projects, use the project ID.

## Tool Usage Statistics

Tool usage statistics are enabled by default. Every MCP tool call is recorded, including all safe `dokploy_*` tools and all upstream `raw_*` tools.

The local fallback log defaults to:

- Windows: `C:\Users\<you>\.codex\dokploy-safe-mcp-usage.jsonl`
- Linux/macOS: `~/.codex/dokploy-safe-mcp-usage.jsonl`

Each event records only `timestamp`, `toolName`, `nodeId`, `ok`, `durationMs`, `mcpName`, and `mcpVersion`. It does not record tool inputs, API keys, passwords, environment variables, upload contents, logs, or error messages.

By default, the MCP also posts the same safe event shape to:

```text
http://183.196.108.32/mcp-usage/events
```

Optional overrides:

```toml
[mcp_servers.dokploy_safe.env]
DOKPLOY_SAFE_USAGE_LOG = "0" # disable local and remote usage statistics
DOKPLOY_SAFE_USAGE_LOG_PATH = "C:\\Users\\Administrator\\.codex\\dokploy-safe-mcp-usage.jsonl"
DOKPLOY_SAFE_USAGE_ENDPOINT = "http://183.196.108.32/mcp-usage/events"
DOKPLOY_SAFE_USAGE_TOKEN = "<collector token override>"
DOKPLOY_SAFE_USAGE_NODE_ID = "office-pc-01"
```

To summarize a local or collected JSONL file with pagination:

```powershell
npm run usage -- --page 1 --pageSize 50
npm run usage -- --log "C:\Users\Administrator\.codex\dokploy-safe-mcp-usage.jsonl" --page 2 --pageSize 50
npm run usage -- --format json --page 1 --pageSize 100
```

The report includes every registered tool, including tools with `count = 0`. Rows include `toolName`, `type`, `count`, `successCount`, `errorCount`, `avgDurationMs`, and `lastUsedAt`. Tool types are `raw`, `safe/wrapper`, and `safe-critical`.

To run the central collector on a host:

```powershell
$env:DOKPLOY_SAFE_USAGE_COLLECTOR_PORT = "18081"
$env:DOKPLOY_SAFE_USAGE_COLLECTOR_LOG_PATH = "C:\Users\Administrator\.codex\dokploy-safe-mcp-usage-central.jsonl"
npm run usage:collector
```

Collector endpoints:

- `POST /mcp-usage/events`: accepts one event or `{ "events": [...] }`, with `Authorization: Bearer <token>`.
- `GET /mcp-usage/summary?page=1&pageSize=50`: returns the paginated JSON summary.
- `GET /mcp-usage/health`: returns collector health and log path.

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

After configuration, remind me to fully restart Codex.

After restart:
- Check Dokploy connectivity with dokploy_connection_check.
- For deployments, use dokploy_deploy_from_local_archive first.
- For status checks, use dokploy_get_project_status.
- For deletion or cleanup, use dokploy_delete_project or dokploy_cleanup_failed_deploy.
- Use raw_* tools only for administrator troubleshooting.
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
