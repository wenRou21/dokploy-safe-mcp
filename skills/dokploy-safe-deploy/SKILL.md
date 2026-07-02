---
name: dokploy-safe-deploy
description: Enforce the deployment rules for this host's Dokploy environment. Use when Codex is asked to deploy, publish, replace, delete, inspect, or troubleshoot projects on Dokploy; when using dokploy_safe MCP; when working with Traefik routes, /join/routes, public paths, app URLs, compose/application publishing, or local archive/static deployments; or when a request mentions 183.196.108.32, port 18080, Dokploy, MCP deployment, route publishing, project replacement, or public URL verification. This skill exists to prevent the common mistake of using 80/443 or project dev ports instead of the required public HTTP entry http://183.196.108.32:18080.
---

# Dokploy Safe Deploy

## Non-Negotiable Rules

- Use `http://183.196.108.32:18080` as the public HTTP entry for every deployed URL.
- Do not assume public ports `80` or `443`.
- Do not use project dev ports such as `3000`, `5173`, `8787`, or container internal ports as browser-facing URLs.
- Format public URLs as `http://183.196.108.32:18080/<path>/`.
- Use a unique public path prefix for each new project, such as `/my-site-20260702`.
- Verify the final public URL on port `18080` before reporting success.

## Preferred MCP

Use `dokploy_safe` as the preferred MCP entry point.

Prefer these safe tools for normal work:

- `dokploy_platform_rules`
- `dokploy_connection_check`
- `dokploy_deploy_static_page`
- `dokploy_deploy_from_local_archive`
- `dokploy_replace_project_from_local_archive`
- `dokploy_publish_route`
- `dokploy_unpublish_route`
- `dokploy_get_project_status`
- `dokploy_check_public_url`
- `dokploy_check_traefik_route`
- `dokploy_diagnose_route`
- `dokploy_delete_project`
- `dokploy_cleanup_failed_deploy`

Avoid raw or in-place mutation tools for normal user deployments. Use `raw_*` tools only for administrator troubleshooting when the safe tool cannot cover the task.

## Workflow

1. Read or call `dokploy_platform_rules` when available.
2. Check connectivity with `dokploy_connection_check` when available.
3. For a simple static page, use `dokploy_deploy_static_page`.
4. For a local project directory or archive, use `dokploy_deploy_from_local_archive`.
5. For changes to an already deployed project, use `dokploy_replace_project_from_local_archive` rather than patching the existing compose/application in place.
6. For an existing compose/application that only needs a public route, use `dokploy_publish_route`.
7. Verify the final URL with `dokploy_check_public_url` or an equivalent HTTP check against `http://183.196.108.32:18080/<path>/`.
8. In the final response, report the verified public URL with port `18080`.

## Route Rules

- Publish public paths through `/join/routes`, normally via `dokploy_publish_route` or the high-level deploy tools.
- Do not write Traefik dynamic files directly for normal workflows.
- Treat `port` arguments as target container/internal service ports, not public browser ports.
- Never point services at `localhost`; use the container/service target expected by Dokploy.

## Failure Handling

If deployment or routing fails, inspect with `dokploy_get_project_status`, `dokploy_diagnose_route`, `dokploy_check_traefik_route`, logs/deployments tools, and then use `dokploy_cleanup_failed_deploy` when cleanup is needed. Keep the `18080` public URL rule in every diagnostic and final answer.
