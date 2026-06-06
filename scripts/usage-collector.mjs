#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_USAGE_TOKEN = "7e48f8f9e8e6402ca73f861c9f84bff2.dokploy-safe-mcp.usage";
const HOST = process.env.DOKPLOY_SAFE_USAGE_COLLECTOR_HOST || "0.0.0.0";
const PORT = Number(process.env.DOKPLOY_SAFE_USAGE_COLLECTOR_PORT || 18081);
const TOKEN = process.env.DOKPLOY_SAFE_USAGE_TOKEN || DEFAULT_USAGE_TOKEN;
const LOG_PATH = process.env.DOKPLOY_SAFE_USAGE_COLLECTOR_LOG_PATH
	|| process.env.DOKPLOY_SAFE_USAGE_LOG_PATH
	|| path.join(os.homedir(), ".codex", "dokploy-safe-mcp-usage-central.jsonl");

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		if (req.method === "POST" && url.pathname === "/mcp-usage/events") {
			await handleEvents(req, res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/mcp-usage/summary") {
			await handleSummary(url, res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/mcp-usage/health") {
			writeJson(res, 200, { ok: true, logPath: LOG_PATH });
			return;
		}
		writeJson(res, 404, { ok: false, error: "not_found" });
	} catch (error) {
		writeJson(res, 500, { ok: false, error: String(error?.message || error) });
	}
});

server.listen(PORT, HOST, () => {
	console.error(`[usage-collector] listening on http://${HOST}:${PORT}`);
	console.error(`[usage-collector] log path: ${LOG_PATH}`);
});

async function handleEvents(req, res) {
	if (!authorized(req)) {
		writeJson(res, 401, { ok: false, error: "unauthorized" });
		return;
	}

	const body = await readBody(req, 1024 * 1024);
	const payload = body ? JSON.parse(body) : {};
	const events = Array.isArray(payload) ? payload : Array.isArray(payload.events) ? payload.events : [payload];
	const normalized = events.map(normalizeEvent).filter(Boolean);
	if (!normalized.length) {
		writeJson(res, 400, { ok: false, error: "no_valid_events" });
		return;
	}

	await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
	await fs.appendFile(LOG_PATH, normalized.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
	writeJson(res, 200, { ok: true, accepted: normalized.length });
}

async function handleSummary(url, res) {
	const page = url.searchParams.get("page") || "1";
	const pageSize = url.searchParams.get("pageSize") || "50";
	const output = await runSummary({ page, pageSize });
	writeJson(res, 200, JSON.parse(output));
}

function normalizeEvent(event) {
	if (!event || typeof event !== "object") return null;
	const toolName = event.toolName || event.tool;
	if (typeof toolName !== "string" || !toolName) return null;
	return {
		timestamp: event.timestamp || event.ts || new Date().toISOString(),
		toolName,
		nodeId: String(event.nodeId || "unknown"),
		ok: event.ok !== false,
		durationMs: Math.max(0, Number(event.durationMs || 0)),
		mcpName: String(event.mcpName || event.mcp || "dokploy-safe-mcp"),
		mcpVersion: String(event.mcpVersion || "unknown"),
	};
}

function authorized(req) {
	const header = req.headers.authorization || "";
	return header === `Bearer ${TOKEN}`;
}

function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				req.destroy(new Error("request too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function runSummary({ page, pageSize }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			fileURLToPath(new URL("./summarize-usage.mjs", import.meta.url)),
			"--log",
			LOG_PATH,
			"--page",
			page,
			"--pageSize",
			pageSize,
			"--format",
			"json",
		], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `summary exited ${code}`));
		});
	});
}

function writeJson(res, statusCode, value) {
	const body = JSON.stringify(value, null, 2);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}
