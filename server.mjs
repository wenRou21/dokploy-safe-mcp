#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { generatedTools as upstreamDokployTools } from "./vendor/dokploy-mcp/generated/tools.js";

const DOKPLOY_URL = trimTrailingSlash(process.env.DOKPLOY_URL || "http://183.196.108.32:18080");
const PUBLIC_HTTP_URL = trimTrailingSlash(process.env.DOKPLOY_PUBLIC_HTTP_URL || DOKPLOY_URL);
const API_KEY = process.env.DOKPLOY_API_KEY;
const DEFAULT_TIMEOUT_MS = Number(process.env.DOKPLOY_SAFE_TIMEOUT_MS || 180000);
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const RAW_TOOL_PREFIX = "raw_";
const MCP_NAME = "dokploy-safe-mcp";
const MCP_VERSION = "1.0.0";
const RAW_MODE = String(process.env.DOKPLOY_SAFE_RAW_MODE || "db").trim().toLowerCase();
const UPLOAD_URL = process.env.DOKPLOY_UPLOAD_URL || `${PUBLIC_HTTP_URL}/join/deployments`;
const UPLOAD_STATUS_URL = process.env.DOKPLOY_UPLOAD_STATUS_URL || `${PUBLIC_HTTP_URL}/join/deployments`;
const UPLOAD_MAX_BYTES = Number(process.env.DOKPLOY_UPLOAD_MAX_MB || 500) * 1024 * 1024;
const ROUTES_URL = process.env.DOKPLOY_ROUTES_URL || `${DOKPLOY_URL}/join/routes`;
const COMPOSE_ROOT = process.env.DOKPLOY_COMPOSE_ROOT || "/etc/dokploy/compose";
const USAGE_ENABLED = !falseyEnv(process.env.DOKPLOY_SAFE_USAGE_LOG);
const USAGE_LOG_PATH = process.env.DOKPLOY_SAFE_USAGE_LOG_PATH || path.join(os.homedir(), ".codex", "dokploy-safe-mcp-usage.jsonl");
const DEFAULT_USAGE_ENDPOINT = "http://183.196.108.32:18080/mcp-usage/events";
const DEFAULT_USAGE_TOKEN = "7e48f8f9e8e6402ca73f861c9f84bff2.dokploy-safe-mcp.usage";
const USAGE_ENDPOINT = trimTrailingSlash(process.env.DOKPLOY_SAFE_USAGE_ENDPOINT || DEFAULT_USAGE_ENDPOINT);
const USAGE_TOKEN = process.env.DOKPLOY_SAFE_USAGE_TOKEN || DEFAULT_USAGE_TOKEN;
const USAGE_NODE_ID = process.env.DOKPLOY_SAFE_USAGE_NODE_ID || defaultUsageNodeId();
const USAGE_REMOTE_ENABLED = truthyEnv(process.env.DOKPLOY_SAFE_USAGE_REMOTE ?? "1")
	&& Boolean(USAGE_ENDPOINT)
	&& Boolean(USAGE_TOKEN);

const RAW_MINIMAL_TOOL_NAMES = new Set([
	"project_all",
	"project_one",
	"environment_byProjectId",
	"compose_search",
	"compose_one",
	"compose_readLogs",
	"application_search",
	"application_one",
	"application_readLogs",
	"deployment_allByCompose",
	"deployment_queueList",
	"docker_getContainers",
	"user_getPermissions",
	"user_session",
	"organization_all",
	"customRole_all",
	"customRole_getStatements",
	"settings_readTraefikFile",
	"settings_readTraefikConfig",
	"settings_readWebServerTraefikConfig",
]);

const RAW_DATABASE_TAGS = new Set([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

const RAW_QUERY_TAGS = new Set([
	"project",
	"environment",
	"compose",
	"application",
	"deployment",
	"docker",
	"user",
	"organization",
	"customrole",
	"settings",
]);

const RAW_BLOCKED_TAGS = new Set([
	"ai",
	"admin",
	"auditlog",
	"backup",
	"bitbucket",
	"certificates",
	"cluster",
	"destination",
	"domain",
	"gitprovider",
	"github",
	"gitea",
	"gitlab",
	"licensekey",
	"mounts",
	"notification",
	"patch",
	"port",
	"previewdeployment",
	"redirects",
	"registry",
	"rollback",
	"schedule",
	"security",
	"sso",
	"sshkey",
	"stripe",
	"swarm",
	"tag",
	"volumebackups",
	"whitelabeling",
]);

const RAW_BLOCKED_NAME_PATTERNS = [
	/traefik.*update/i,
	/update.*traefik/i,
	/reloadtraefik/i,
	/create$/i,
	/update$/i,
	/delete$/i,
	/remove$/i,
	/deploy$/i,
	/redeploy$/i,
	/reload$/i,
	/start$/i,
	/stop$/i,
	/kill/i,
	/cancel/i,
	/save/i,
	/clear/i,
	/clean/i,
	/move/i,
	/disconnect/i,
	/drop/i,
];

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
	name: MCP_NAME,
	version: MCP_VERSION,
}, {
	instructions: [
		"This server is the single preferred MCP entry point for Dokploy on this host.",
		"It includes safe deployment/route publishing tools plus common Dokploy inspection and management tools.",
		"Before deploying to Dokploy or publishing a public path, use dokploy_deploy_static_page or dokploy_publish_route.",
		"By default it exposes only selected raw_* Dokploy tools for troubleshooting and database management.",
		"Set DOKPLOY_SAFE_RAW_MODE=full only for temporary administrator troubleshooting.",
		"Do not assume public ports 80/443. The public HTTP entry is http://183.196.108.32:18080.",
		"Member API keys normally cannot write Traefik files directly. Use /join/routes through dokploy_publish_route or dokploy_deploy_static_page.",
		"New public deployments must use a unique path prefix and verify the final public URL returns 200.",
	].join(" "),
});

instrumentToolUsage(server);

server.tool(
	"dokploy_platform_rules",
	[
			"Return the required deployment rules for this Dokploy host.",
			"For normal deployment, route publishing, status, cleanup, and deletion, prefer the high-level dokploy_* workflow tools.",
			"Use raw dokploy MCP tools only for advanced administrator troubleshooting.",
	].join(" "),
	{},
	async () => jsonToolResult({
		ok: true,
		message: "Use dokploy_safe as the preferred entry point for deployment and route publishing.",
		preferredTools: [
			"dokploy_deploy_from_local_archive",
			"dokploy_deploy_static_page",
			"dokploy_publish_route",
			"dokploy_unpublish_route",
			"dokploy_get_project_status",
			"dokploy_delete_project",
			"dokploy_cleanup_failed_deploy",
		],
		rawDokployUseCases: [
			"Use raw_* tools only for advanced upstream Dokploy API operations not wrapped by safe tools.",
		],
		rules: platformRules(),
	}),
);

if (RAW_MODE === "full") {
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
}

server.tool(
	"dokploy_connection_check",
	"Check Dokploy API connectivity and return projects, applications, and compose lists. Use this instead of a separate base dokploy MCP connectivity check.",
	{
		limit: z.number().int().positive().optional().describe("Maximum applications and compose rows to return. Default 100."),
	},
	async (input) => {
		const limit = clampSearchLimit(input.limit);
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
		limit: z.number().int().positive().max(100).optional(),
		offset: z.number().int().nonnegative().optional(),
		name: z.string().optional(),
		q: z.string().optional(),
		projectId: z.string().optional(),
		environmentId: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/application.search", {
		limit: clampSearchLimit(input.limit),
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
		limit: z.number().int().positive().max(100).optional(),
		offset: z.number().int().nonnegative().optional(),
		name: z.string().optional(),
		q: z.string().optional(),
		projectId: z.string().optional(),
		environmentId: z.string().optional(),
		appName: z.string().optional(),
	},
	async (input) => jsonToolResult(await dokploy("GET", "/compose.search", {
		limit: clampSearchLimit(input.limit),
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
	"dokploy_unpublish_route",
	[
		"Remove a public path route that was created through /join/routes.",
		"This tool calls DELETE /join/routes through the route manager and verifies the public path no longer returns 200.",
	].join(" "),
	{
		path: z.string().describe("External path prefix to remove, for example /my-site."),
		verifyTimeoutMs: z.number().int().positive().optional().describe("Public URL removal verification timeout in milliseconds."),
	},
	async (input) => jsonToolResult(await unpublishRouteAndVerify(input)),
);

server.tool(
	"dokploy_get_project_status",
	"Resolve one visible project and return its environments, compose apps, deployments, managed routes, and public route checks.",
	{
		projectIdOrName: z.string().describe("Project ID or exact/unique project name."),
		verifyRoutes: z.boolean().default(true).describe("Whether to check each managed route over public HTTP."),
	},
	async (input) => jsonToolResult(await getProjectStatus(input.projectIdOrName, { verifyRoutes: input.verifyRoutes })),
);

server.tool(
	"dokploy_delete_project",
	[
		"Delete one visible Dokploy project by exact ID or unique name, plus its managed public routes.",
		"The target must resolve to exactly one project. If cleanupContainers is true, this also removes leftover containers for the project's compose apps after project.remove.",
	].join(" "),
	{
		projectIdOrName: z.string().describe("Project ID or exact/unique project name."),
		deleteRoutes: z.boolean().default(true).describe("Remove /join/routes managed public routes before deleting."),
		cleanupContainers: z.boolean().default(true).describe("Try to stop/remove leftover Docker containers for project compose app names."),
		verifyTimeoutMs: z.number().int().positive().optional().describe("Route deletion verification timeout in milliseconds."),
	},
	async (input) => jsonToolResult(await deleteProject(input)),
);

server.tool(
	"dokploy_cleanup_failed_deploy",
	[
		"Clean up a failed or partial deployment by project, compose, or route path.",
		"Use this when upload/deploy/publish partially succeeded and left a project, route, or container behind.",
	].join(" "),
	{
		projectIdOrName: z.string().optional().describe("Project ID or exact/unique project name."),
		composeId: z.string().optional().describe("Compose ID belonging to the failed deployment."),
		path: z.string().optional().describe("Managed public route path, for example /my-site."),
		deleteRoutes: z.boolean().default(true),
		cleanupContainers: z.boolean().default(true),
		verifyTimeoutMs: z.number().int().positive().optional(),
	},
	async (input) => jsonToolResult(await cleanupFailedDeploy(input)),
);

server.tool(
	"dokploy_prepare_upload_slot",
	[
		"Return the HTTP upload endpoint used for large local project deployments.",
		"Use dokploy_deploy_from_local_archive to upload and deploy automatically.",
	].join(" "),
	{
		name: z.string().optional().describe("Optional human-readable project name for the upload directory."),
	},
	async (input) => {
		const result = await prepareUploadSlot(input.name);
		return jsonToolResult(result);
	},
);

server.tool(
	"dokploy_deploy_from_local_archive",
	[
		"Deploy a local archive or directory by uploading it to the Dokploy host over HTTP multipart first.",
		"This avoids embedding large source code blobs into MCP JSON or docker-compose.",
		"Modes: auto, static, dockerfile, and railpack. The server creates a Dokploy raw compose, deploys it, publishes through /join/routes, and verifies the public URL.",
	].join(" "),
	{
		sourcePath: z.string().describe("Local path on the machine running Codex/MCP. Can be a directory, .zip, .tar, .tar.gz, or .tgz."),
		name: z.string().optional().describe("Base project name. Defaults to the source path name plus a timestamp."),
		path: z.string().optional().describe("Unique public path prefix, for example /burst-guardians. Defaults to /<name>."),
		mode: z.enum(["auto", "static", "dockerfile", "railpack"]).default("auto"),
		port: z.number().int().positive().default(80).describe("Internal container port to publish."),
		env: z.record(z.string()).default({}).describe("Environment variables for generated dockerfile/static compose modes."),
		verifyTimeoutMs: z.number().int().positive().optional().describe("Deployment and public URL verification timeout in milliseconds."),
	},
	async (input) => {
		const result = await deployFromLocalArchive(input);
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

async function prepareUploadSlot(name) {
	return {
		ok: true,
		name: sanitizeName(name || `upload-${timestampSlug()}`),
		uploadUrl: UPLOAD_URL,
		maxUploadBytes: UPLOAD_MAX_BYTES,
		nextTool: "dokploy_deploy_from_local_archive",
		sourcePathNote: "Pass a local directory or archive to dokploy_deploy_from_local_archive; it will upload over HTTP multipart automatically.",
	};
}

async function deployFromLocalArchive(input) {
	assertConfigured();
	const localSource = path.resolve(String(input.sourcePath || ""));
	const sourceStat = await fs.stat(localSource);
	const stamp = timestampSlug();
	const baseName = sanitizeName(input.name || path.basename(localSource, path.extname(localSource)) || `archive-${stamp}`);
	const publicPath = input.path ? normalizePath(input.path) : undefined;
	if (publicPath) {
		validatePath(publicPath);
	}
	const localPayload = await makeLocalPayload(localSource, sourceStat, baseName);
	const payloadStat = await fs.stat(localPayload.path);
	if (payloadStat.size > UPLOAD_MAX_BYTES) {
		throw new Error(`Upload payload is ${payloadStat.size} bytes, above DOKPLOY_UPLOAD_MAX_MB limit (${UPLOAD_MAX_BYTES} bytes).`);
	}

	try {
		return uploadAndDeploy({
			localPayload,
			name: baseName,
			path: publicPath,
			mode: input.mode || "auto",
			port: input.port || 80,
			env: input.env || {},
			verifyTimeoutMs: input.verifyTimeoutMs || DEFAULT_TIMEOUT_MS,
		});
	} finally {
		if (localPayload.cleanup) {
			await fs.rm(localPayload.path, { force: true }).catch(() => undefined);
		}
	}
}

async function uploadAndDeploy(input) {
	const filename = path.basename(input.localPayload.path);
	const form = await uploadForm(input, filename);
	const response = await fetch(UPLOAD_URL, {
		method: "POST",
		headers: form.headers || undefined,
		body: form.body,
		...(form.duplex ? { duplex: form.duplex } : {}),
		signal: AbortSignal.timeout(300000),
	});
	const text = await response.text();
	const data = parseJsonText(text);
	if (!response.ok) {
		const message = typeof data === "object" && data
			? data.message || data.error || JSON.stringify(data)
			: text;
		throw new Error(`Upload deployment failed: HTTP ${response.status} ${response.statusText}: ${message}`);
	}
	if (data && typeof data === "object" && data.taskId && data.status !== "done") {
		return waitForUploadDeploymentTask(data, input.verifyTimeoutMs);
	}
	if (data && typeof data === "object" && data.status === "done" && data.result) {
		return data.result;
	}
	return data;
}

async function waitForUploadDeploymentTask(initial, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = initial;
	const statusUrl = `${UPLOAD_STATUS_URL}/${encodeURIComponent(initial.taskId)}`;

	while (Date.now() < deadline) {
		const url = new URL(statusUrl);
		url.searchParams.set("apiKey", API_KEY);
		try {
			const response = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(30000),
			});
			const text = await response.text();
			const data = parseJsonText(text);
			if (!response.ok) {
				const message = typeof data === "object" && data
					? data.message || data.error || JSON.stringify(data)
					: text;
				throw new Error(`Upload deployment status failed: HTTP ${response.status} ${response.statusText}: ${message}`);
			}
			last = data;
			if (data?.status === "done" && data.result) {
				return {
					...data.result,
					taskId: data.taskId || initial.taskId,
					taskStatus: data.status,
					taskMessage: data.message,
				};
			}
			if (data?.ok === true && data.result) {
				return {
					...data.result,
					taskId: data.taskId || initial.taskId,
					taskStatus: data.status,
					taskMessage: data.message,
				};
			}
			if (data?.status === "error") {
				throw new Error(`Upload deployment failed: ${data.message || JSON.stringify(data)}`);
			}
		} catch (error) {
			if (!isNetworkError(error)) {
				throw error;
			}
			last = { statusPollError: error.message };
		}
		await delay(3000);
	}

	throw new Error(`Timed out waiting for uploaded deployment task ${initial.taskId}. Last status: ${JSON.stringify(last)}`);
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

	const attempts = [];
	const verifyTimeoutMs = input.verifyTimeoutMs || DEFAULT_TIMEOUT_MS;
	let route = null;
	let verification = null;
	let url = null;

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			route = await publishRoute(body);
			url = route.url || `${PUBLIC_HTTP_URL}${path.endsWith("/") ? path : `${path}/`}`;
		} catch (error) {
			if (!isRouteAlreadyOwnedError(error) || !url) {
				throw error;
			}

			attempts.push({
				attempt,
				ok: false,
				phase: "publish",
				routeAlreadyExists: true,
				error: error.message,
			});
		}

		try {
			verification = await waitForPublicUrl(url, perAttemptTimeout(verifyTimeoutMs, attempt));
			attempts.push({
				attempt,
				ok: true,
				targetUrl: route.targetUrl,
				verification,
			});
			break;
		} catch (error) {
			attempts.push({
				attempt,
				ok: false,
				phase: "verify",
				targetUrl: route.targetUrl,
				error: error.message,
			});

			if (attempt === 3) {
				throw new Error([
					`Route was published but public URL verification failed for ${url}.`,
					"This often means Traefik cannot resolve the target container alias yet, or the route-manager did not attach the container to the public bridge with the expected alias.",
					"If attempts include routeAlreadyExists=true, /join/routes is not idempotently refreshing an existing route; update route-manager so same path + same owner re-runs the network alias repair instead of returning reserved.",
					`Attempts: ${JSON.stringify(attempts)}`,
				].join(" "));
			}

			await delay(5000 * attempt);
		}
	}

	return {
		ok: true,
		kind: hasCompose ? "compose" : "application",
		message: "Route published through /join/routes and public URL verified. If earlier attempts failed, /join/routes was retried to refresh the container network alias.",
		path,
		url,
		targetUrl: route.targetUrl,
		ownerId: route.ownerId,
		target: hasCompose
			? { composeId: input.composeId, serviceName: input.serviceName, port }
			: { applicationId: input.applicationId, port },
		verification,
		attempts,
		rulesApplied: platformRules(),
	};
}

async function publishRoute(body) {
	return httpJson(ROUTES_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60000,
	});
}

async function unpublishRouteAndVerify(input) {
	assertConfigured();
	const path = normalizePath(input.path);
	validatePath(path);
	const result = await deleteRoute({ apiKey: API_KEY, path });
	const url = result.url || `${PUBLIC_HTTP_URL}${path}`;
	const verification = await waitForPublicUrlNotOk(url, input.verifyTimeoutMs || 60000);
	return {
		ok: true,
		message: "Route removed through /join/routes and public URL no longer returns 200.",
		path,
		url,
		route: result,
		verification,
	};
}

async function deleteRoute(body) {
	return httpJson(ROUTES_URL, {
		method: "DELETE",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60000,
	});
}

async function getProjectStatus(projectIdOrName, options = {}) {
	assertConfigured();
	const project = await resolveProject(projectIdOrName);
	const projectId = project.projectId || project.id;
	const environments = rowsOf(await tryDokploy("GET", "/environment.byProjectId", { projectId }));
	const compose = await searchComposes({ projectId });
	const applications = await searchApplications({ projectId });
	const deployments = [];
	for (const item of compose) {
		const composeId = item.composeId || item.id;
		if (!composeId) continue;
		deployments.push({
			composeId,
			appName: item.appName || item.name,
			latest: latestDeployment(await tryDokploy("GET", "/deployment.allByCompose", { composeId })),
		});
	}
	const routes = await managedRoutesForTargets({
		composeIds: compose.map((item) => item.composeId || item.id).filter(Boolean),
		applicationIds: applications.map((item) => item.applicationId || item.id).filter(Boolean),
	});
	const routeChecks = [];
	if (options.verifyRoutes !== false) {
		for (const route of routes) {
			routeChecks.push({
				path: route.path,
				url: `${PUBLIC_HTTP_URL}${route.path}`,
				check: await quickPublicUrlCheck(`${PUBLIC_HTTP_URL}${route.path}`),
			});
		}
	}
	return {
		ok: true,
		project,
		environments,
		compose,
		applications,
		deployments,
		routes,
		routeChecks,
	};
}

async function deleteProject(input) {
	assertConfigured();
	const startedAt = new Date().toISOString();
	const before = await getProjectStatus(input.projectIdOrName, { verifyRoutes: false });
	const projectId = before.project.projectId || before.project.id;
	const steps = [];

	if (input.deleteRoutes !== false) {
		for (const route of before.routes) {
			try {
				const removed = await unpublishRouteAndVerify({
					path: route.path,
					verifyTimeoutMs: input.verifyTimeoutMs || 60000,
				});
				steps.push({ step: "unpublish_route", path: route.path, ok: true, result: removed });
			} catch (error) {
				steps.push({ step: "unpublish_route", path: route.path, ok: false, error: error.message });
			}
		}
	}

	try {
		const removed = await dokploy("POST", "/project.remove", { projectId });
		steps.push({ step: "project_remove", projectId, ok: true, result: removed });
	} catch (error) {
		steps.push({ step: "project_remove", projectId, ok: false, error: error.message });
		throw new Error(`Project removal failed for ${projectId}: ${error.message}`);
	}

	if (input.cleanupContainers !== false) {
		for (const appName of composeAppNames(before.compose)) {
			const cleanup = await cleanupContainersByAppName(appName);
			steps.push({ step: "cleanup_containers", appName, ...cleanup });
			const composeDirCleanup = await cleanupComposeDirectory(appName);
			steps.push({ step: "cleanup_compose_directory", appName, ...composeDirCleanup });
		}
	}

	const projectCheck = await tryDokploy("GET", "/project.one", { projectId });
	const remainingRoutes = await managedRoutesForTargets({
		composeIds: before.compose.map((item) => item.composeId || item.id).filter(Boolean),
		applicationIds: before.applications.map((item) => item.applicationId || item.id).filter(Boolean),
	});

	return {
		ok: !projectCheck && remainingRoutes.length === 0,
		message: "Project delete workflow completed.",
		projectId,
		projectName: before.project.name,
		startedAt,
		completedAt: new Date().toISOString(),
		before,
		steps,
		verification: {
			projectGone: !projectCheck,
			remainingRoutes,
		},
	};
}

async function cleanupFailedDeploy(input) {
	assertConfigured();
	if (!input.projectIdOrName && !input.composeId && !input.path) {
		throw new Error("Provide projectIdOrName, composeId, or path.");
	}

	let projectIdOrName = input.projectIdOrName;
	if (!projectIdOrName && input.composeId) {
		const compose = await dokploy("GET", "/compose.one", { composeId: input.composeId });
		projectIdOrName = compose.projectId || compose.project?.projectId || compose.project?.id;
		if (!projectIdOrName) {
			projectIdOrName = await projectIdForEnvironment(compose.environmentId);
		}
	}
	if (!projectIdOrName && input.path) {
		const path = normalizePath(input.path);
		const route = (await managedRoutesForTargets({ paths: [path] }))[0];
		if (route?.ownerId) {
				const compose = await tryDokploy("GET", "/compose.one", { composeId: route.ownerId });
				projectIdOrName = compose?.projectId || compose?.project?.projectId || compose?.project?.id;
				if (!projectIdOrName && compose?.environmentId) {
					projectIdOrName = await projectIdForEnvironment(compose.environmentId);
				}
				if (!projectIdOrName) {
					const app = await tryDokploy("GET", "/application.one", { applicationId: route.ownerId });
					projectIdOrName = app?.projectId || app?.project?.projectId || app?.project?.id;
					if (!projectIdOrName && app?.environmentId) {
						projectIdOrName = await projectIdForEnvironment(app.environmentId);
					}
				}
			}
		}

	const routeOnlySteps = [];
	if (input.path) {
		try {
			const removed = await unpublishRouteAndVerify({
				path: input.path,
				verifyTimeoutMs: input.verifyTimeoutMs || 60000,
			});
			routeOnlySteps.push({ step: "unpublish_route", path: normalizePath(input.path), ok: true, result: removed });
		} catch (error) {
			routeOnlySteps.push({ step: "unpublish_route", path: normalizePath(input.path), ok: false, error: error.message });
		}
	}

	if (!projectIdOrName) {
		return {
			ok: routeOnlySteps.every((step) => step.ok),
			message: "Only route cleanup was possible; no project could be resolved from the provided input.",
			steps: routeOnlySteps,
		};
	}

	const deleted = await deleteProject({
		projectIdOrName,
		deleteRoutes: input.deleteRoutes !== false,
		cleanupContainers: input.cleanupContainers !== false,
		verifyTimeoutMs: input.verifyTimeoutMs,
	});
	return {
		ok: deleted.ok && routeOnlySteps.every((step) => step.ok),
		message: "Failed deployment cleanup completed.",
		preSteps: routeOnlySteps,
		deleteProject: deleted,
	};
}

function isRouteAlreadyOwnedError(error) {
	const message = error?.message || "";
	return message.includes("Path is reserved or already owned")
		|| message.includes("already owned by another route")
		|| message.includes("reserved");
}

function perAttemptTimeout(totalTimeoutMs, attempt) {
	const minimum = 20000;
	const remainingAttempts = 4 - attempt;
	return Math.max(minimum, Math.floor(totalTimeoutMs / remainingAttempts));
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

async function waitForPublicUrlNotOk(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = null;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				method: "GET",
				headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
				redirect: "manual",
				signal: AbortSignal.timeout(10000),
			});
			const text = await response.text();
			last = {
				status: response.status,
				contentType: response.headers.get("content-type"),
				snippet: text.replace(/\s+/g, " ").slice(0, 240),
			};
			if (response.status !== 200) {
				return {
					ok: true,
					status: response.status,
					contentType: last.contentType,
					snippet: last.snippet,
				};
			}
		} catch (error) {
			return {
				ok: true,
				error: error.message,
			};
		}

		await delay(3000);
	}

	throw new Error(`Public URL still returned 200 for ${url}. Last result: ${JSON.stringify(last)}`);
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

	return httpJsonWithRetry(url, init);
}

async function httpJsonWithRetry(url, init, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await httpJson(url, init);
		} catch (error) {
			lastError = error;
			if (!isNetworkError(error) || attempt === attempts) {
				throw error;
			}
			await delay(500 * attempt);
		}
	}
	throw lastError;
}

function isNetworkError(error) {
	const message = error?.message || "";
	return message === "fetch failed"
		|| message.includes("The operation was aborted")
		|| message.includes("ECONNRESET")
		|| message.includes("UND_ERR");
}

async function resolveProject(projectIdOrName) {
	const needle = String(projectIdOrName || "").trim();
	if (!needle) throw new Error("projectIdOrName is required.");

	const direct = await tryDokploy("GET", "/project.one", { projectId: needle });
	if (direct) return direct;

	const projects = rowsOf(await dokploy("GET", "/project.all"));
	const matches = projects.filter((project) => {
		const values = [
			project.projectId,
			project.id,
			project.name,
			project.appName,
			project.slug,
		].filter(Boolean).map(String);
		return values.includes(needle);
	});

	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`Project name matched multiple projects; use projectId. Candidates: ${JSON.stringify(matches.map(projectSummary))}`);
	}

	throw new Error(`No visible project matched ${needle}`);
}

async function searchComposes(filter = {}) {
	return rowsOf(await tryDokploy("GET", "/compose.search", {
		limit: 100,
		offset: 0,
		...filter,
	}));
}

async function searchApplications(filter = {}) {
	return rowsOf(await tryDokploy("GET", "/application.search", {
		limit: 100,
		offset: 0,
		...filter,
	}));
}

async function projectIdForEnvironment(environmentId) {
	if (!environmentId) return null;
	for (const project of rowsOf(await dokploy("GET", "/project.all"))) {
		const projectId = project.projectId || project.id;
		if (!projectId) continue;
		const environments = rowsOf(await tryDokploy("GET", "/environment.byProjectId", { projectId }));
		if (environments.some((env) => (env.environmentId || env.id) === environmentId)) {
			return projectId;
		}
	}
	return null;
}

function rowsOf(value) {
	if (Array.isArray(value)) return value.filter(isObject);
	if (!isObject(value)) return [];
	for (const key of ["data", "rows", "items", "projects", "applications", "compose", "composes", "deployments"]) {
		if (Array.isArray(value[key])) return value[key].filter(isObject);
	}
	return [];
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectSummary(project) {
	return {
		projectId: project.projectId || project.id,
		name: project.name,
	};
}

function composeAppNames(compose) {
	return [...new Set(compose.map((item) => item.appName || item.name).filter(Boolean).map(String))];
}

async function managedRoutesForTargets({ composeIds = [], applicationIds = [], paths = [] }) {
	const targetIds = new Set([...composeIds, ...applicationIds].filter(Boolean).map(String));
	const targetPaths = new Set(paths.map((item) => normalizePath(item)));
	const routes = parseManagedRoutes(await readTraefikConfig());
	return routes.filter((route) => {
		if (targetPaths.size && targetPaths.has(route.path)) return true;
		if (targetIds.size && targetIds.has(route.ownerId)) return true;
		return false;
	});
}

async function readTraefikConfig() {
	const queryPath = `/settings.readTraefikFile?path=${encodeURIComponent("/etc/dokploy/traefik/dynamic/manual-ai-platform.yml")}`;
	const data = await tryDokploy("GET", queryPath, {});
	if (typeof data === "string") return data;
	if (isObject(data)) return data.content || data.data || data.traefikConfig || "";
	return "";
}

function parseManagedRoutes(config) {
	const text = String(config || "");
	const routes = [];
	const metaRe = /^# route-manager owner=([^ ]*) path=(\/[^ ]+) kind=([A-Za-z0-9_-]+)/gm;
	let match;
	while ((match = metaRe.exec(text))) {
		routes.push({
			ownerId: match[1],
			path: match[2],
			kind: match[3],
		});
	}

	const prefixRe = /PathPrefix\(`(\/[^`]+)`\)/g;
	while ((match = prefixRe.exec(text))) {
		if (!routes.some((route) => route.path === match[1])) {
			routes.push({ ownerId: "", path: match[1], kind: "unknown" });
		}
	}
	return routes;
}

async function quickPublicUrlCheck(url) {
	try {
		const response = await fetch(url, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(10000),
		});
		const text = await response.text();
		return {
			ok: response.status === 200,
			status: response.status,
			contentType: response.headers.get("content-type"),
			snippet: text.replace(/\s+/g, " ").slice(0, 160),
		};
	} catch (error) {
		return { ok: false, error: error.message };
	}
}

async function cleanupContainersByAppName(appName) {
	const containers = rowsOf(await tryDokploy("GET", "/docker.getContainersByAppNameMatch", { appName }));
	const matched = containers.filter((container) => {
		const values = [
			container.name,
			container.containerName,
			container.Names?.join?.(" "),
			container.appName,
		].filter(Boolean).join(" ");
		return values.includes(appName);
	});
	const steps = [];
	for (const container of matched) {
		const containerId = container.containerId || container.id || container.Id;
		if (!containerId) continue;
		try {
			await dokploy("POST", "/docker.stopContainer", { containerId });
			steps.push({ action: "stop", containerId, ok: true });
		} catch (error) {
			steps.push({ action: "stop", containerId, ok: false, error: error.message });
		}
		try {
			await dokploy("POST", "/docker.removeContainer", { containerId });
			steps.push({ action: "remove", containerId, ok: true });
		} catch (error) {
			steps.push({ action: "remove", containerId, ok: false, error: error.message });
		}
	}
	return {
		ok: steps.every((step) => step.ok),
		matched: matched.length,
		steps,
	};
}

async function cleanupComposeDirectory(appName) {
	const safeName = String(appName || "");
	if (!/^[A-Za-z0-9._-]+$/.test(safeName)) {
		return { ok: false, skipped: true, reason: "appName is not a safe compose directory name" };
	}
	const root = path.resolve(COMPOSE_ROOT);
	const target = path.resolve(root, safeName);
	if (!target.startsWith(`${root}${path.sep}`)) {
		return { ok: false, skipped: true, reason: "resolved compose directory is outside compose root" };
	}
	try {
		await fs.rm(target, { recursive: true, force: true });
		return { ok: true, path: target };
	} catch (error) {
		return { ok: false, path: target, error: error.message };
	}
}

async function multipartBody(fields, file) {
	const boundary = `----dokploy-safe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const chunks = [];
	let contentLength = 0;
	for (const [key, value] of Object.entries(fields)) {
		const chunk = Buffer.from([
			`--${boundary}`,
			`Content-Disposition: form-data; name="${escapeMultipartName(key)}"`,
			"",
			String(value),
			"",
		].join("\r\n"));
		contentLength += chunk.length;
		chunks.push(chunk);
	}
	const fileHeader = Buffer.from([
		`--${boundary}`,
		`Content-Disposition: form-data; name="${escapeMultipartName(file.fieldName)}"; filename="${escapeMultipartName(file.filename)}"`,
		`Content-Type: ${file.contentType}`,
	].join("\r\n") + "\r\n\r\n");
	const fileStat = await fs.stat(file.filePath);
	const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
	contentLength += fileHeader.length + fileStat.size + fileFooter.length;
	chunks.push(fileHeader);
	chunks.push(createReadStream(file.filePath));
	chunks.push(fileFooter);

	return {
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": String(contentLength),
		},
		body: ReadableStreamFrom(chunks),
	};
}

async function uploadForm(input, filename) {
	const fields = {
		apiKey: API_KEY,
		name: input.name,
		mode: input.mode,
		port: String(input.port),
	};
	if (input.path) fields.path = input.path;
	for (const [key, value] of Object.entries(input.env || {})) {
		fields[`env_${key}`] = String(value);
	}

	return {
		...(await multipartBody(fields, {
			fieldName: "archive",
			filePath: input.localPayload.path,
			filename,
			contentType: archiveContentType(filename),
		})),
		duplex: "half",
	};
}

function ReadableStreamFrom(chunks) {
	return new ReadableStream({
		async start(controller) {
			try {
				for (const chunk of chunks) {
					if (Buffer.isBuffer(chunk)) {
						controller.enqueue(chunk);
						continue;
					}
					for await (const part of chunk) {
						controller.enqueue(part);
					}
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

function escapeMultipartName(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, "_");
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

function instrumentToolUsage(mcpServer) {
	const originalTool = mcpServer.tool.bind(mcpServer);
	mcpServer.tool = (...args) => {
		const name = String(args[0] || "unknown");
		const handlerIndex = findLastFunctionIndex(args);
		if (handlerIndex !== -1) {
			const handler = args[handlerIndex];
			args[handlerIndex] = async (...handlerArgs) => {
				const startedAt = new Date();
				const started = Date.now();
				try {
					const result = await handler(...handlerArgs);
					recordUsage({
						timestamp: startedAt.toISOString(),
						toolName: name,
						ok: true,
						durationMs: Date.now() - started,
					});
					return result;
				} catch (error) {
					recordUsage({
						timestamp: startedAt.toISOString(),
						toolName: name,
						ok: false,
						durationMs: Date.now() - started,
					});
					throw error;
				}
			};
		}
		return originalTool(...args);
	};
}

function findLastFunctionIndex(values) {
	for (let index = values.length - 1; index >= 0; index--) {
		if (typeof values[index] === "function") return index;
	}
	return -1;
}

function recordUsage(entry) {
	if (!USAGE_ENABLED) return;
	const usageEvent = {
		timestamp: entry.timestamp,
		toolName: entry.toolName,
		nodeId: USAGE_NODE_ID,
		ok: entry.ok,
		durationMs: entry.durationMs,
		mcpName: MCP_NAME,
		mcpVersion: MCP_VERSION,
	};
	void persistUsage(usageEvent);
}

async function persistUsage(entry) {
	await Promise.allSettled([
		writeUsageLog(entry),
		reportUsage(entry),
	]);
}

async function writeUsageLog(entry) {
	try {
		await fs.mkdir(path.dirname(USAGE_LOG_PATH), { recursive: true });
		await fs.appendFile(USAGE_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.error(`[dokploy-safe-mcp] Failed to write usage log: ${error.message}`);
	}
}

async function reportUsage(entry) {
	if (!USAGE_REMOTE_ENABLED) return;
	try {
		await fetch(USAGE_ENDPOINT, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${USAGE_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(entry),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// Usage reporting must never affect MCP tool execution.
	}
}

function getEnabledUpstreamTools() {
	const enabledTags = process.env.DOKPLOY_ENABLED_TAGS;
	if (enabledTags) {
		const tags = new Set(enabledTags
			.split(",")
			.map((tag) => tag.trim().toLowerCase())
			.filter(Boolean));

		return upstreamDokployTools.filter((tool) => tags.has(tool.tag.toLowerCase()));
	}

	if (RAW_MODE === "full") {
		return upstreamDokployTools;
	}

	if (RAW_MODE === "off" || RAW_MODE === "none" || RAW_MODE === "0") {
		return [];
	}

	const mode = RAW_MODE === "minimal" ? "minimal" : "db";
	return upstreamDokployTools.filter((tool) => isRawToolAllowed(tool, mode));
}

function isRawToolAllowed(tool, mode) {
	const normalizedName = tool.name.replace(/-/g, "_");
	const tag = tool.tag.toLowerCase();
	const path = tool.path.toLowerCase();
	const method = tool.method.toUpperCase();

	if (RAW_MINIMAL_TOOL_NAMES.has(normalizedName)) return true;
	if (mode === "db" && RAW_DATABASE_TAGS.has(tag)) return true;

	if (RAW_BLOCKED_TAGS.has(tag)) return false;
	if (RAW_BLOCKED_NAME_PATTERNS.some((pattern) => pattern.test(normalizedName))) return false;

	if (method === "GET" && RAW_QUERY_TAGS.has(tag)) return true;
	if (method === "GET" && path.includes("readlogs")) return true;
	if (method === "GET" && path.includes("readtraefik")) return true;

	return false;
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

function clampSearchLimit(limit) {
	if (limit === undefined || limit === null) {
		return 100;
	}

	return Math.min(Math.max(Number(limit), 1), 100);
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

function truthyEnv(value) {
	return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function falseyEnv(value) {
	return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function defaultUsageNodeId() {
	try {
		return `${os.hostname()}-${os.userInfo().username}`;
	} catch {
		return os.hostname();
	}
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function yamlString(value) {
	return JSON.stringify(String(value));
}

function yamlKey(value) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`Invalid environment variable name: ${value}`);
	}

	return value;
}

function archiveContentType(filename) {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".zip")) {
		return "application/zip";
	}
	if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
		return "application/gzip";
	}
	return "application/octet-stream";
}

function parseJsonText(text) {
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

async function makeLocalPayload(sourcePath, sourceStat, name) {
	if (!sourceStat.isDirectory()) {
		const lower = sourcePath.toLowerCase();
		if (lower.endsWith(".zip")) {
			return { path: sourcePath, kind: "zip", extension: "zip", cleanup: false };
		}
		if (lower.endsWith(".tar")) {
			return { path: sourcePath, kind: "tar", extension: "tar", cleanup: false };
		}
		if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
			return { path: sourcePath, kind: "tgz", extension: "tgz", cleanup: false };
		}
	}

	const archivePath = path.join(os.tmpdir(), `dokploy-safe-${name}-${Date.now()}.tgz`);
	const cwd = sourceStat.isDirectory() ? sourcePath : path.dirname(sourcePath);
	const item = sourceStat.isDirectory() ? "." : path.basename(sourcePath);
	await runLocal("tar", ["-czf", archivePath, "-C", cwd, item], 120000);
	return { path: archivePath, kind: "tgz", extension: "tgz", cleanup: true };
}

function runLocal(command, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) {
				const message = stderr?.trim() || stdout?.trim() || error.message;
				reject(new Error(`${command} failed: ${message}`));
				return;
			}

			resolve({ stdout, stderr });
		});
	});
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
