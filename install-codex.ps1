param(
	[Parameter(Mandatory = $true)]
	[string]$ApiKey,

	[string]$McpName = "dokploy_safe",
	[string]$DokployUrl = "http://183.196.108.32:18080",
	[string]$PublicHttpUrl = "http://183.196.108.32:18080"
)

$ErrorActionPreference = "Stop"

$mcpDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $mcpDir "server.mjs"
$configDir = Join-Path $env:USERPROFILE ".codex"
$configPath = Join-Path $configDir "config.toml"

if (-not (Test-Path -LiteralPath $serverPath)) {
	throw "server.mjs not found at $serverPath"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	throw "Node.js was not found in PATH. Install Node.js first, then rerun this script."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	throw "npm was not found in PATH. Install Node.js/npm first, then rerun this script."
}

Push-Location $mcpDir
try {
	if (-not (Test-Path -LiteralPath (Join-Path $mcpDir "node_modules"))) {
		npm install
	}
} finally {
	Pop-Location
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if (Test-Path -LiteralPath $configPath) {
	$content = Get-Content -Raw -LiteralPath $configPath
	$stamp = Get-Date -Format "yyyyMMddHHmmss"
	Copy-Item -LiteralPath $configPath -Destination "$configPath.bak-$McpName-$stamp"
} else {
	$content = ""
}

$escapedServerPath = $serverPath.Replace("\", "\\")
$block = @"
[mcp_servers.$McpName]
command = "node"
args = ["$escapedServerPath"]
enabled = true
startup_timeout_sec = 120

[mcp_servers.$McpName.env]
DOKPLOY_URL = "$DokployUrl"
DOKPLOY_PUBLIC_HTTP_URL = "$PublicHttpUrl"
DOKPLOY_API_KEY = "$ApiKey"
"@

$serverPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($McpName))\]\r?\n.*?(?=^\[|\z)"
$envPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($McpName))\.env\]\r?\n.*?(?=^\[|\z)"

$content = [regex]::Replace($content, $serverPattern, "")
$content = [regex]::Replace($content, $envPattern, "")
$content = $content.TrimEnd() + "`r`n`r`n" + $block + "`r`n"

Set-Content -LiteralPath $configPath -Value $content -Encoding UTF8

Write-Output "Installed $McpName MCP into $configPath"
Write-Output "MCP server path: $serverPath"
Write-Output "Restart Codex completely, then ask Codex to use dokploy_deploy_static_page."
