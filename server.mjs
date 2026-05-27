#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { generatedTools as upstreamDokployTools } from "./vendor/dokploy-mcp/generated/tools.js";

const DOKPLOY_URL = trimTrailingSlash(process.env.DOKPLOY_URL || "http://183.196.108.32:18080");
const PUBLIC_HTTP_URL = trimTrailingSlash(process.env.DOKPLOY_PUBLIC_HTTP_URL || DOKPLOY_URL);
const API_KEY = process.env.DOKPLOY_API_KEY;
const DEFAULT_TIMEOUT_MS = Number(process.env.DOKPLOY_SAFE_TIMEOUT_MS || 180000);
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const RAW_TOOL_PREFIX = "raw_";

const RESERVED_PATHS = new Set([
	"api",
	"join",
	"dashboard",
	"login",
	"register",
	"invitation",
	"settings",
	"websocket",
]);

const server = new McpServer({
	name: "dokploy-safe-mcp",
	version: "1.0.0",
}, {
	instructions: [
		"This server is the single preferred MCP entry point for Dokploy on this host.",
		"It includes safe deployment/route publishing tools plus common Dokploy inspection and management tools.",
		"Before deploying to Dokploy or publishing a public path, use dokploy_deploy_static_page or dokploy_publish_route.",
		"It also exposes the full upstream Dokploy MCP API as raw_* tools for advanced operations.",
		"Do not assume public ports 80/443. The public HTTP entry is http://183.196.108.32:18080.",
		"Member API keys normally cannot write Traefik files directly. Use /join/routes through dokploy_publish_route or dokploy_deploy_static_page.",
		"New public deployments must use a unique path prefix and verify the final public URL returns 200.",
	].join(" "),
});

server.tool(
	"dokploy_platform_rules",
	[
		"Return the required deployment rules for this Dokploy host.",
		"Call this before using raw dokploy MCP tools for deployment-related work.",
		"For deployment and route publishing, prefer dokploy_deploy_static_page or dokploy_publish_route.",
	].join(" "),
	{},
	async () => jsonToolResult({
		ok: true,
		message: "Use dokploy_safe as the preferred entry point for deployment and route publishing.",
		preferredTools: [
			"dokploy_deploy_static_page",
			"dokploy_publish_route",
		],
		rawDokployUseCases: [
			"Use built-in dokploy_* tools in this MCP for common listing, detail, logs, status, and deploy operations.",
			"Use raw_* tools in this MCP for advanced upstream Dokploy API operations not wrapped by safe tools.",
		],
		rules: platformRules(),
	}),
);

server.tool(
	"dokploy_raw_api",
	"Advanced escape hatch for any Dokploy OpenAPI endpoint. Prefer named safe tools for deployment and route publishing. Use method GET or POST and a path such as /project.all or /compose.update.",
	{
		method: z.enum(["GET", "POST"]),
		path: z.string().describe("Dokploy API path, for example /project.all or /compose.update."),
		params: z.record(z.any()).optional().describe("GET query parameters or POST JSON body."),
	},
	async (input) => jsonToolResult(await dokploy(input.method, normalizeApiPath(input.path), input.params || {})),
);

server.tool(
	"dokploy_connection_check",
	"Check Dokploy API connectivity and return projects, applications, and compose lists. Use this instead of a separate base dokploy MCP connectivity check.",
	{
		limit: z.number().int().positive().optional().describe("Maximum applications and compose rows to return. Default 100."),
	},
	async (input) => {
		const limit = input.limit || 100;
		const [projects, applications, compose] = await Promise.all([
			dokploy("GET", "/project.all"),
			dokploy("GET", "/application.search", { limit, offset: 0 }),
			dokploy("GET", "/compose.search", { limit, offset: 0 }),
		]);

		return jsonToolResult({
			ok: true,
			dokployUrl: DOKPLOY_URL,
			projects,
			applications,
			compose,
		});
	},
);

server.tool(
	"dokploy_project_all",
	"List all Dokploy projects visible to the configured API key.",
	{},
	async () => jsonToolResult(await dokploy("GET", "/project.all")),
);

server.tool(
	"dokploy_project_one",
	"Get one Dokploy project by projectId.",
	{
		projectId: z.string().describe("Dokploy projectId."),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/project.one", { projectId: input.projectId })),
);

server.tool(
	"dokploy_project_create",
	"Create a Dokploy project. For public deployment, prefer dokploy_deploy_static_page when applicable.",
	{
		name: z.string(),
		description: z.string().nullable().optional(),
		env: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/project.create", input)),
);

server.tool(
	"dokploy_environment_by_project_id",
	"List environments for a Dokploy project.",
	{
		projectId: z.string(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/environment.byProjectId", { projectId: input.projectId })),
);

server.tool(
	"dokploy_environment_create",
	"Create an environment in a Dokploy project.",
	{
		name: z.string(),
		description: z.string().optional(),
		projectId: z.string(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/environment.create", input)),
);

server.tool(
	"dokploy_application_search",
	"Search/list Dokploy applications visible to the configured API key.",
	{
		limit: z.number().int().positive().optional(),
		offset: z.number().int().nonnegative().optional(),
		name: z.string().optional(),
		q: z.string().optional(),
		projectId: z.string().optional(),
		environmentId: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/application.search", {
		limit: input.limit || 100,
		offset: input.offset || 0,
		name: input.name,
		q: input.q,
		projectId: input.projectId,
		environmentId: input.environmentId,
	})),
);

server.tool(
	"dokploy_application_one",
	"Get one Dokploy application by applicationId.",
	{
		applicationId: z.string(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/application.one", { applicationId: input.applicationId })),
);

server.tool(
	"dokploy_application_deploy",
	"Deploy an existing Dokploy application. After deploying, use dokploy_publish_route to publish/verify the public path.",
	{
		applicationId: z.string(),
		title: z.string().optional(),
		description: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/application.deploy", input)),
);

server.tool(
	"dokploy_application_read_logs",
	"Read logs for a Dokploy application.",
	{
		applicationId: z.string(),
		tail: z.number().int().positive().optional(),
		since: z.string().optional(),
		search: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/application.readLogs", input)),
);

server.tool(
	"dokploy_compose_search",
	"Search/list Dokploy compose services visible to the configured API key.",
	{
		limit: z.number().int().positive().optional(),
		offset: z.number().int().nonnegative().optional(),
		name: z.string().optional(),
		q: z.string().optional(),
		projectId: z.string().optional(),
		environmentId: z.string().optional(),
		appName: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/compose.search", {
		limit: input.limit || 100,
		offset: input.offset || 0,
		name: input.name,
		q: input.q,
		projectId: input.projectId,
		environmentId: input.environmentId,
		appName: input.appName,
	})),
);

server.tool(
	"dokploy_compose_one",
	"Get one Dokploy compose by composeId.",
	{
		composeId: z.string(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/compose.one", { composeId: input.composeId })),
);

server.tool(
	"dokploy_compose_create",
	"Create a Dokploy compose. For public static deployments, prefer dokploy_deploy_static_page.",
	{
		name: z.string(),
		environmentId: z.string(),
		description: z.string().nullable().optional(),
		composeType: z.enum(["docker-compose", "stack"]).optional(),
		appName: z.string().optional(),
		serverId: z.string().nullable().optional(),
		composeFile: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/compose.create", input)),
);

server.tool(
	"dokploy_compose_update",
	"Update a Dokploy compose. For raw compose deployments, set sourceType=raw and composeType=docker-compose to avoid accidental GitHub source resolution.",
	{
		composeId: z.string(),
		name: z.string().optional(),
		appName: z.string().optional(),
		description: z.string().nullable().optional(),
		env: z.string().nullable().optional(),
		composeFile: z.string().optional(),
		sourceType: z.enum(["git", "github", "gitlab", "bitbucket", "gitea", "raw"]).optional(),
		composeType: z.enum(["docker-compose", "stack"]).optional(),
		composeStatus: z.enum(["idle", "running", "done", "error"]).optional(),
		autoDeploy: z.boolean().nullable().optional(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/compose.update", input)),
);

server.tool(
	"dokploy_compose_deploy",
	"Deploy an existing Dokploy compose. After deploying, use dokploy_publish_route to publish/verify the public path.",
	{
		composeId: z.string(),
		title: z.string().optional(),
		description: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("POST", "/compose.deploy", input)),
);

server.tool(
	"dokploy_compose_deployments",
	"List deployments for a Dokploy compose.",
	{
		composeId: z.string(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/deployment.allByCompose", { composeId: input.composeId })),
);

server.tool(
	"dokploy_compose_read_logs",
	"Read logs for a Dokploy compose container.",
	{
		composeId: z.string(),
		containerId: z.string(),
		tail: z.number().int().positive().optional(),
		since: z.string().optional(),
		search: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/compose.readLogs", input)),
);

server.tool(
	"dokploy_publish_route",
	[
		"Preferred tool for publishing any Dokploy public route on this host.",
		"Use this before or instead of raw dokploy MCP when a compose/application needs a public path.",
		"Publish a safe path route for an existing Dokploy compose or application.",
		"This tool never writes Traefik directly. It calls /join/routes, which validates the user's API key,",
		"creates Host(183.196.108.32) && PathPrefix(/xxx), defaults stripPrefix, reloads Traefik server-side,",
		"and verifies the public URL on http://183.196.108.32:18080.",
	].join(" "),
	{
		path: z.string().describe("Unique external path prefix, for example /my-site."),
		composeId: z.string().optional().describe("Dokploy composeId. Use with serviceName and port."),
		applicationId: z.string().optional().describe("Dokploy applicationId. Use with port."),
		serviceName: z.string().optional().describe("Compose service name, for example app."),
		port: z.number().int().positive().describe("Internal container port, not a public host port."),
		verifyTimeoutMs: z.number().int().positive().optional().describe("Public URL verification timeout in milliseconds."),
	},
	async (input) => {
		const result = await publishRouteAndVerify({
			path: input.path,
			composeId: input.composeId,
			applicationId: input.applicationId,
			serviceName: input.serviceName,
			port: input.port,
			verifyTimeoutMs: input.verifyTimeoutMs,
		});

		return jsonToolResult(result);
	},
);

server.tool(
	"dokploy_deploy_static_page",
	[
		"Preferred tool for deploying a simple static page to this Dokploy host.",
		"Use this before or instead of raw dokploy MCP for static-page deployments.",
		"Deploy a simple static page to Dokploy using nginx:alpine, then publish and verify a safe path route.",
		"It creates a project, production environment, raw docker-compose compose, forces compose.update with sourceType=raw,",
		"deploys the compose, publishes through /join/routes, and verifies http://183.196.108.32:18080/<path>/ returns 200.",
		"Use this instead of manually assuming 80/443 or writing Traefik files.",
	].join(" "),
	{
		name: z.string().optional().describe("Base name for project and compose. A safe unique name is generated if omitted."),
		path: z.string().optional().describe("Unique external path prefix. A path based on name is generated if omitted."),
		title: z.string().optional().describe("HTML page title."),
		html: z.string().optional().describe("Full HTML content. If omitted, a simple static page is generated."),
		verifyTimeoutMs: z.number().int().positive().optional().describe("Deployment and public URL verification timeout in milliseconds."),
	},
	async (input) => {
		const result = await deployStaticPage(input);
		return jsonToolResult(result);
	},
);

registerUpstreamDokployTools(server);

async function deployStaticPage(input) {
	assertConfigured();

	const stamp = timestampSlug();
	const random = Math.random().toString(36).slice(2, 8);
	const baseName = sanitizeName(input.name || `safe-static-${stamp}-${random}`);
	const path = normalizePath(input.path || `/${baseName}`);
	validatePath(path);

	const projectName = baseName;
	const environmentName = "production";
	const composeName = `${baseName}-compose`;
	const serviceName = "app";
	const port = 80;
	const title = input.title || "Dokploy Safe Static Page";
	const html = input.html || defaultHtml(title, path);
	const composeFile = buildStaticCompose(serviceName, html);
	const startedAt = new Date().toISOString();

	const project = await dokploy("POST", "/project.create", {
		name: projectName,
		description: "Static page deployed through dokploy-safe-mcp",
	});
	const projectId = pickId(project, "projectId");
	const environment = project.environment || await dokploy("POST", "/environment.create", {
		name: environmentName,
		description: "Created by dokploy-safe-mcp",
		projectId,
	});
	const environmentId = pickId(environment, "environmentId");

	const compose = await dokploy("POST", "/compose.create", {
		name: composeName,
		description: "Static nginx page deployed through dokploy-safe-mcp",
		environmentId,
		composeType: "docker-compose",
		appName: composeName,
		composeFile,
	});
	const composeId = pickId(compose, "composeId");

	await dokploy("POST", "/compose.update", {
		composeId,
		name: composeName,
		appName: composeName,
		description: "Static nginx page deployed through dokploy-safe-mcp",
		composeFile,
		sourceType: "raw",
		composeType: "docker-compose",
		composeStatus: "idle",
		repository: null,
		owner: null,
		branch: null,
		autoDeploy: false,
	});

	await dokploy("POST", "/compose.deploy", {
		composeId,
		title: "Deploy static page",
		description: "dokploy-safe-mcp deploy_static_page",
	});

	const timeoutMs = input.verifyTimeoutMs || DEFAULT_TIMEOUT_MS;
	const deployment = await waitForComposeDeployment(composeId, timeoutMs);
	const route = await publishRouteAndVerify({
		path,
		composeId,
		serviceName,
		port,
		verifyTimeoutMs: timeoutMs,
	});

	return {
		ok: true,
		kind: "static-compose",
		message: "Static page deployed, route published, and public URL verified.",
		url: route.url,
		path,
		projectId,
		environmentId,
		composeId,
		serviceName,
		port,
		deployment,
		route,
		startedAt,
		completedAt: new Date().toISOString(),
		rulesApplied: platformRules(),
	};
}

async function publishRouteAndVerify(input) {
	assertConfigured();

	const path = normalizePath(input.path);
	validatePath(path);
	const hasCompose = Boolean(input.composeId);
	const hasApplication = Boolean(input.applicationId);

	if (hasCompose === hasApplication) {
		throw new Error("Provide exactly one target: composeId or applicationId.");
	}

	if (hasCompose && !input.serviceName) {
		throw new Error("serviceName is required when publishing a compose route.");
	}

	const port = Number(input.port);
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error("port must be a positive internal container port.");
	}

	const body = {
		apiKey: API_KEY,
		path,
		port,
	};

	if (hasCompose) {
		body.composeId = input.composeId;
		body.serviceName = input.serviceName;
	} else {
		body.applicationId = input.applicationId;
	}

	const route = await httpJson(`${DOKPLOY_URL}/join/routes`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60000,
	});

	const url = route.url || `${PUBLIC_HTTP_URL}${path.endsWith("/") ? path : `${path}/`}`;
	const verification = await waitForPublicUrl(url, input.verifyTimeoutMs || DEFAULT_TIMEOUT_MS);

	return {
		ok: true,
		kind: hasCompose ? "compose" : "application",
		message: "Route published through /join/routes and public URL verified.",
		path,
		url,
		targetUrl: route.targetUrl,
		ownerId: route.ownerId,
		target: hasCompose
			? { composeId: input.composeId, serviceName: input.serviceName, port }
			: { applicationId: input.applicationId, port },
		verification,
		rulesApplied: platformRules(),
	};
}

async function waitForComposeDeployment(composeId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastStatus = "unknown";
	let lastDeployment = null;

	while (Date.now() < deadline) {
		const compose = await dokploy("GET", "/compose.one", { composeId });
		lastStatus = compose.composeStatus || compose.status || lastStatus;
		lastDeployment = latestDeployment(await tryDokploy("GET", "/deployment.allByCompose", { composeId }));

		const deploymentStatus = statusOf(lastDeployment);
		if (lastStatus === "done" || deploymentStatus === "done" || deploymentStatus === "success") {
			return {
				ok: true,
				composeStatus: lastStatus,
				deploymentStatus,
				deploymentId: lastDeployment?.deploymentId || lastDeployment?.id,
			};
		}

		if (lastStatus === "error" || deploymentStatus === "error" || deploymentStatus === "failed") {
			throw new Error(`Compose deployment failed. composeStatus=${lastStatus}, deploymentStatus=${deploymentStatus}`);
		}

		await delay(4000);
	}

	throw new Error(`Timed out waiting for compose deployment. Last composeStatus=${lastStatus}, last deploymentStatus=${statusOf(lastDeployment)}`);
}

async function waitForPublicUrl(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = null;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				method: "GET",
				headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
				redirect: "follow",
				signal: AbortSignal.timeout(10000),
			});
			const text = await response.text();
			last = {
				status: response.status,
				finalUrl: response.url,
				contentType: response.headers.get("content-type"),
				snippet: text.replace(/\s+/g, " ").slice(0, 240),
			};
			if (response.status === 200) {
				return {
					ok: true,
					status: response.status,
					finalUrl: response.url,
					contentType: last.contentType,
					snippet: last.snippet,
				};
			}
		} catch (error) {
			last = { error: error.message };
		}

		await delay(3000);
	}

	throw new Error(`Public URL verification failed for ${url}. Last result: ${JSON.stringify(last)}`);
}

async function dokploy(method, path, data) {
	const url = new URL(`${DOKPLOY_URL}/api${path}`);
	const init = {
		method,
		headers: {
			"x-api-key": API_KEY,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		timeoutMs: 60000,
	};

	if (method === "GET") {
		for (const [key, value] of Object.entries(data || {})) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
	} else {
		init.body = JSON.stringify(data || {});
	}

	return httpJson(url, init);
}

function registerUpstreamDokployTools(mcpServer) {
	const tools = getEnabledUpstreamTools();

	for (const tool of tools) {
		const name = `${RAW_TOOL_PREFIX}${tool.name.replace(/-/g, "_")}`;
		mcpServer.tool(
			name,
			[
				`Upstream Dokploy MCP tool: ${tool.description}.`,
				"Advanced raw operation. For deployment and public routes on this host, prefer dokploy_deploy_static_page or dokploy_publish_route.",
			].join(" "),
			tool.schema.shape,
			tool.annotations ?? {},
			async (input) => jsonToolResult(await dokploy(tool.method, tool.path, input || {})),
		);
	}

	const originalListToolsHandler = mcpServer.server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
	mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
		const result = await originalListToolsHandler(request, extra);
		return {
			tools: result.tools.map((tool) => ({
				...tool,
				inputSchema: toDraft2020_12JsonSchema(tool.inputSchema),
			})),
		};
	});
}

function getEnabledUpstreamTools() {
	const enabledTags = process.env.DOKPLOY_ENABLED_TAGS;
	if (!enabledTags) {
		return upstreamDokployTools;
	}

	const tags = new Set(enabledTags
		.split(",")
		.map((tag) => tag.trim().toLowerCase())
		.filter(Boolean));

	return upstreamDokployTools.filter((tool) => tags.has(tool.tag.toLowerCase()));
}

function toDraft2020_12JsonSchema(schema) {
	const result = schema?.type === "object" && schema.properties
		? structuredClone(schema)
		: zodToJsonSchema(schema, {
			target: "jsonSchema2019-09",
			strictUnions: true,
		});

	stripNestedSchemaKeys(result);
	result.$schema = JSON_SCHEMA_2020_12;
	return result;
}

function stripNestedSchemaKeys(value) {
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) stripNestedSchemaKeys(item);
		return;
	}

	for (const key of Object.keys(value)) {
		if (key === "$schema") {
			delete value[key];
		} else {
			stripNestedSchemaKeys(value[key]);
		}
	}
}

async function tryDokploy(method, path, data) {
	try {
		return await dokploy(method, path, data);
	} catch {
		return null;
	}
}

async function httpJson(url, init) {
	const timeoutMs = init.timeoutMs || 60000;
	const response = await fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let parsed;

	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}

	if (!response.ok) {
		const message = typeof parsed === "object" && parsed
			? parsed.message || parsed.error || JSON.stringify(parsed)
			: String(parsed || response.statusText);
		throw new Error(`HTTP ${response.status} ${response.statusText} from ${response.url}: ${message}`);
	}

	return parsed;
}

function buildStaticCompose(serviceName, html) {
	const encodedHtml = Buffer.from(html, "utf8").toString("base64");

	return [
		"services:",
		`  ${serviceName}:`,
		"    image: nginx:alpine",
		"    restart: unless-stopped",
		"    command:",
		"      - /bin/sh",
		"      - -c",
		`      - printf '%s' '${encodedHtml}' | base64 -d > /usr/share/nginx/html/index.html && nginx -g 'daemon off;'`,
	].join("\n");
}

function defaultHtml(title, path) {
	const now = new Date().toISOString();
	return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #17202a; }
    main { width: min(720px, calc(100vw - 40px)); padding: 36px; background: white; border: 1px solid #dfe4ea; border-radius: 8px; box-shadow: 0 18px 50px rgba(20, 35, 50, .08); }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.2; }
    p { margin: 8px 0; color: #4d5b6a; line-height: 1.7; }
    code { padding: 2px 6px; border-radius: 4px; background: #eef2f6; color: #1f2d3d; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>这个静态页面由 <code>dokploy-safe-mcp</code> 自动部署并发布路径。</p>
    <p>访问路径：<code>${escapeHtml(path)}</code></p>
    <p>部署时间：<code>${escapeHtml(now)}</code></p>
  </main>
</body>
</html>`;
}

function latestDeployment(value) {
	const rows = Array.isArray(value) ? value : value?.deployments || value?.data || [];
	if (!Array.isArray(rows) || rows.length === 0) return null;

	return [...rows].sort((a, b) => {
		const ad = Date.parse(a.createdAt || a.created_at || 0);
		const bd = Date.parse(b.createdAt || b.created_at || 0);
		return bd - ad;
	})[0];
}

function statusOf(value) {
	return (value?.status || value?.deploymentStatus || value?.state || value?.composeStatus || "").toString().toLowerCase();
}

function pickId(value, field) {
	if (value?.[field]) return value[field];
	if (value?.data?.[field]) return value.data[field];
	if (value?.project?.[field]) return value.project[field];
	if (value?.environment?.[field]) return value.environment[field];
	if (value?.compose?.[field]) return value.compose[field];
	if (value?.application?.[field]) return value.application[field];
	throw new Error(`Dokploy response did not include ${field}: ${JSON.stringify(value)}`);
}

function normalizePath(path) {
	if (!path || typeof path !== "string") {
		throw new Error("path is required.");
	}

	const trimmed = path.trim();
	return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function validatePath(path) {
	const slug = path.slice(1);
	if (!slug) {
		throw new Error("path must not be root (/). Use a unique prefix such as /my-site.");
	}

	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) {
		throw new Error("path may only contain letters, numbers, dots, underscores, and hyphens, for example /my-site.");
	}

	if (RESERVED_PATHS.has(slug.toLowerCase())) {
		throw new Error(`path /${slug} is reserved. Use a unique project path.`);
	}
}

function normalizeApiPath(path) {
	if (!path || typeof path !== "string") {
		throw new Error("path is required.");
	}

	const trimmed = path.trim();
	const withoutApi = trimmed.replace(/^\/?api\//, "");
	return `/${withoutApi.replace(/^\/+/, "")}`;
}

function sanitizeName(name) {
	const safe = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);

	return safe || `safe-static-${timestampSlug()}`;
}

function timestampSlug() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function trimTrailingSlash(value) {
	return value.replace(/\/+$/, "");
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertConfigured() {
	if (!API_KEY) {
		throw new Error("DOKPLOY_API_KEY is required in the MCP server environment.");
	}
}

function platformRules() {
	return [
		"Use http://183.196.108.32:18080 as the public HTTP entry; do not assume 80/443.",
		"Use a unique path prefix for each project.",
		"Member API keys do not write Traefik directly; traefikFiles.write=false is normal.",
		"Publish routes through POST /join/routes.",
		"/join/routes creates Host(183.196.108.32) && PathPrefix(/xxx) and defaults stripPrefix.",
		"Compose targets use serviceName + internal port; application targets use applicationId + internal port.",
		"Never point services at localhost.",
	];
}

function jsonToolResult(value) {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(value, null, 2),
			},
		],
	};
}

const transport = new StdioServerTransport();
await server.connect(transport);
