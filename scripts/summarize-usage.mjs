#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RAW_TOOL_PREFIX = "raw_";
const CRITICAL_SAFE_TOOLS = new Set([
	"dokploy_publish_route",
	"dokploy_unpublish_route",
	"dokploy_deploy_from_local_archive",
	"dokploy_deploy_static_page",
	"dokploy_get_project_status",
	"dokploy_delete_project",
	"dokploy_cleanup_failed_deploy",
	"dokploy_prepare_upload_slot",
	"dokploy_connection_check",
	"dokploy_platform_rules",
]);

const options = parseArgs(process.argv.slice(2));
const logPath = options.log
	|| process.env.DOKPLOY_SAFE_USAGE_LOG_PATH
	|| path.join(os.homedir(), ".codex", "dokploy-safe-mcp-usage.jsonl");
const page = positiveInt(options.page, 1);
const pageSize = positiveInt(options.pageSize, 50);
const format = options.format || "table";

const allTools = await readAllToolNames();
const events = await readRows(logPath);
const report = buildReport({ allTools, events, page, pageSize });

if (format === "json") {
	console.log(JSON.stringify(report, null, 2));
} else {
	printReport(report, logPath);
}

async function readAllToolNames() {
	const serverPath = new URL("../server.mjs", import.meta.url);
	const generatedToolsPath = new URL("../vendor/dokploy-mcp/generated/tools.js", import.meta.url);
	const text = await fs.readFile(serverPath, "utf8");
	const generatedText = await fs.readFile(generatedToolsPath, "utf8");
	const names = [];
	for (const match of text.matchAll(/server\.tool\(\s*[\r\n]+\s*"([^"]+)"/g)) {
		names.push(match[1]);
	}
	for (const match of generatedText.matchAll(/\bname:\s*"([^"]+)"/g)) {
		names.push(`${RAW_TOOL_PREFIX}${match[1].replace(/-/g, "_")}`);
	}
	return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function readRows(filePath) {
	let text;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}

	const rows = [];
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const line = rawLine.replace(/^\uFEFF/, "");
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			const toolName = row.toolName || row.tool;
			if (row && typeof toolName === "string") {
				rows.push({
					...row,
					toolName,
					timestamp: row.timestamp || row.ts,
				});
			}
		} catch (error) {
			console.error(`Skipping invalid JSONL line ${index + 1}: ${error.message}`);
		}
	}
	return rows;
}

function buildReport({ allTools, events, page, pageSize }) {
	const summary = new Map();
	for (const toolName of allTools) {
		summary.set(toolName, emptySummary(toolName));
	}

	for (const event of events) {
		const item = summary.get(event.toolName) || emptySummary(event.toolName);
		item.count++;
		if (event.ok === false) item.errorCount++;
		else item.successCount++;
		item.totalDurationMs += Number(event.durationMs || 0);
		if (event.timestamp && (!item.lastUsedAt || event.timestamp > item.lastUsedAt)) {
			item.lastUsedAt = event.timestamp;
		}
		summary.set(event.toolName, item);
	}

	const rows = [...summary.values()]
		.map((item) => ({
			toolName: item.toolName,
			type: classifyTool(item.toolName),
			count: item.count,
			successCount: item.successCount,
			errorCount: item.errorCount,
			avgDurationMs: item.count ? Math.round(item.totalDurationMs / item.count) : 0,
			lastUsedAt: item.lastUsedAt,
		}))
		.sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName));

	const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * pageSize;
	const pageRows = rows.slice(start, start + pageSize);

	return {
		page: safePage,
		pageSize,
		totalPages,
		totalTools: rows.length,
		totalEvents: events.length,
		rows: pageRows,
	};
}

function emptySummary(toolName) {
	return {
		toolName,
		count: 0,
		successCount: 0,
		errorCount: 0,
		totalDurationMs: 0,
		lastUsedAt: null,
	};
}

function classifyTool(toolName) {
	if (toolName.startsWith(RAW_TOOL_PREFIX)) return "raw";
	if (CRITICAL_SAFE_TOOLS.has(toolName)) return "safe-critical";
	if (toolName.startsWith("dokploy_")) return "safe/wrapper";
	return "other";
}

function printReport(report, logPath) {
	console.log(`Usage log: ${logPath}`);
	console.log(`Events: ${report.totalEvents}`);
	console.log(`Tools: ${report.totalTools}`);
	console.log(`Page: ${report.page}/${report.totalPages} (pageSize=${report.pageSize})`);
	console.log("");
	printTable(report.rows);
	console.log("");
	console.log("Use --page N --pageSize N to page through all tools, or --format json for machine-readable output.");
}

function printTable(items) {
	const headers = ["toolName", "type", "count", "successCount", "errorCount", "avgDurationMs", "lastUsedAt"];
	const widths = Object.fromEntries(headers.map((header) => [
		header,
		Math.max(header.length, ...items.map((item) => String(item[header] ?? "").length)),
	]));
	console.log(headers.map((header) => pad(header, widths[header])).join("  "));
	console.log(headers.map((header) => "-".repeat(widths[header])).join("  "));
	for (const item of items) {
		console.log(headers.map((header) => pad(String(item[header] ?? ""), widths[header])).join("  "));
	}
}

function parseArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--log") options.log = args[++index];
		else if (arg === "--page") options.page = args[++index];
		else if (arg === "--pageSize") options.pageSize = args[++index];
		else if (arg === "--format") options.format = args[++index];
		else if (!options.log) options.log = arg;
	}
	return options;
}

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pad(value, width) {
	return value.padEnd(width, " ");
}
