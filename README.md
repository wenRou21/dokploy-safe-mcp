# dokploy-safe-mcp

Safe Dokploy deployment wrapper MCP for this server.

It provides:

- `dokploy_deploy_static_page`
- `dokploy_publish_route`

The tools always use the public entry `http://183.196.108.32:18080`, publish routes through `/join/routes`, and verify the final public URL returns 200.

## Recommended npx config from GitHub

After this folder is pushed to GitHub, users do not need to download the folder manually. They can add this to Codex config and replace the GitHub repo plus API key:

```toml
[mcp_servers.dokploy_safe]
command = "npx"
args = ["-y", "github:<GITHUB_USER_OR_ORG>/dokploy-safe-mcp"]
enabled = true
startup_timeout_sec = 120

[mcp_servers.dokploy_safe.env]
DOKPLOY_URL = "http://183.196.108.32:18080"
DOKPLOY_PUBLIC_HTTP_URL = "http://183.196.108.32:18080"
DOKPLOY_API_KEY = "<YOUR_DOKPLOY_API_KEY>"
```

Then restart Codex completely.

Codex prompt template:

```text
请帮我配置 Dokploy safe MCP。

MCP 包地址：
github:<GITHUB_USER_OR_ORG>/dokploy-safe-mcp

我的 Dokploy API Key：
<YOUR_DOKPLOY_API_KEY>

请把它加入 Codex MCP 配置，DOKPLOY_URL 和 DOKPLOY_PUBLIC_HTTP_URL 都用 http://183.196.108.32:18080。配置完成后提醒我彻底重启 Codex。
```

## Automatic install

After downloading this folder, ask Codex to run the installer with your own Dokploy API key.

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -ApiKey "<YOUR_DOKPLOY_API_KEY>"
```

Linux/macOS:

```bash
chmod +x ./install-codex.sh
./install-codex.sh "<YOUR_DOKPLOY_API_KEY>"
```

Then restart Codex completely.

## Manual Codex config template

Keep the normal `@dokploy/mcp` server if you still want raw Dokploy tools. Or add this extra MCP server manually and replace `<YOUR_DOKPLOY_API_KEY>`:

```toml
[mcp_servers.dokploy_safe]
command = "node"
args = ["C:\\Users\\Administrator\\.codex\\mcp\\dokploy-safe-mcp\\server.mjs"]
enabled = true
startup_timeout_sec = 120

[mcp_servers.dokploy_safe.env]
DOKPLOY_URL = "http://183.196.108.32:18080"
DOKPLOY_PUBLIC_HTTP_URL = "http://183.196.108.32:18080"
DOKPLOY_API_KEY = "<YOUR_DOKPLOY_API_KEY>"
```

After editing Codex config, restart Codex so the new MCP tools are loaded.
