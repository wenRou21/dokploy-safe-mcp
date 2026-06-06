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
		if (req.method === "GET" && (url.pathname === "/mcp-usage" || url.pathname === "/mcp-usage/")) {
			redirect(res, "/mcp-usage/dashboard");
			return;
		}
		if (req.method === "GET" && url.pathname === "/mcp-usage/dashboard") {
			writeHtml(res, dashboardHtml());
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

function redirect(res, location) {
	res.writeHead(302, { Location: location });
	res.end();
}

function writeHtml(res, html) {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": Buffer.byteLength(html),
	});
	res.end(html);
}

function dashboardHtml() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Dokploy Safe MCP Usage</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f6f7fb;
			--panel: #ffffff;
			--panel-soft: #f0f4f8;
			--line: #d9e0ea;
			--text: #18212f;
			--muted: #66758a;
			--accent: #0f766e;
			--accent-strong: #115e59;
			--danger: #b42318;
			--warning: #b54708;
			--raw: #315efb;
			--safe: #0f766e;
			--critical: #7c3aed;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			background: var(--bg);
			color: var(--text);
			font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		header {
			position: sticky;
			top: 0;
			z-index: 2;
			background: rgba(246, 247, 251, 0.94);
			backdrop-filter: blur(10px);
			border-bottom: 1px solid var(--line);
		}
		.header-inner {
			max-width: 1180px;
			margin: 0 auto;
			padding: 18px 20px 14px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
		}
		h1 {
			margin: 0;
			font-size: 22px;
			font-weight: 720;
			letter-spacing: 0;
		}
		.subtle { color: var(--muted); }
		main {
			max-width: 1180px;
			margin: 0 auto;
			padding: 18px 20px 28px;
		}
		.stats {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 10px;
			margin-bottom: 14px;
		}
		.stat, .toolbar, .table-wrap {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
		}
		.stat {
			padding: 14px;
			min-height: 82px;
		}
		.stat-label {
			color: var(--muted);
			font-size: 12px;
			margin-bottom: 8px;
		}
		.stat-value {
			font-size: 26px;
			font-weight: 750;
			font-variant-numeric: tabular-nums;
		}
		.toolbar {
			padding: 12px;
			display: grid;
			grid-template-columns: minmax(180px, 1fr) 150px 120px 120px 110px auto auto;
			gap: 10px;
			align-items: center;
			margin-bottom: 14px;
		}
		input, select, button {
			height: 36px;
			border-radius: 6px;
			border: 1px solid var(--line);
			background: #fff;
			color: var(--text);
			padding: 0 10px;
			font: inherit;
			min-width: 0;
		}
		button {
			cursor: pointer;
			background: var(--accent);
			border-color: var(--accent);
			color: #fff;
			font-weight: 650;
			white-space: nowrap;
		}
		button.secondary {
			background: #fff;
			color: var(--accent-strong);
			border-color: #9bc8c2;
		}
		label.check {
			display: inline-flex;
			align-items: center;
			gap: 7px;
			height: 36px;
			color: var(--muted);
			white-space: nowrap;
		}
		label.check input {
			width: 16px;
			height: 16px;
			padding: 0;
		}
		.table-wrap {
			overflow: hidden;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			table-layout: fixed;
		}
		th, td {
			padding: 11px 12px;
			border-bottom: 1px solid var(--line);
			text-align: left;
			vertical-align: middle;
		}
		th {
			background: var(--panel-soft);
			color: var(--muted);
			font-size: 12px;
			font-weight: 700;
		}
		td {
			font-variant-numeric: tabular-nums;
		}
		tr:last-child td { border-bottom: 0; }
		.tool {
			font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
			overflow-wrap: anywhere;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			height: 24px;
			padding: 0 8px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 700;
			background: #eef2ff;
			color: var(--raw);
			white-space: nowrap;
		}
		.badge.safe { background: #e6f5f2; color: var(--safe); }
		.badge.critical { background: #f1e9ff; color: var(--critical); }
		.err { color: var(--danger); font-weight: 700; }
		.ok { color: var(--safe); font-weight: 700; }
		.footer {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 12px;
			border-top: 1px solid var(--line);
			background: #fff;
		}
		.pages {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.pages button {
			width: 36px;
			padding: 0;
		}
		.loading, .empty {
			padding: 34px 12px;
			text-align: center;
			color: var(--muted);
		}
		@media (max-width: 900px) {
			.stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
			.toolbar { grid-template-columns: 1fr 1fr; }
			.table-wrap { overflow-x: auto; }
			table { min-width: 850px; }
		}
		@media (max-width: 560px) {
			.header-inner { align-items: flex-start; flex-direction: column; }
			.stats { grid-template-columns: 1fr; }
			.toolbar { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<header>
		<div class="header-inner">
			<div>
				<h1>Dokploy Safe MCP Usage</h1>
				<div class="subtle" id="caption">Loading usage summary...</div>
			</div>
			<button class="secondary" id="refreshBtn">Refresh</button>
		</div>
	</header>
	<main>
		<section class="stats">
			<div class="stat"><div class="stat-label">Total tools</div><div class="stat-value" id="totalTools">-</div></div>
			<div class="stat"><div class="stat-label">Total events</div><div class="stat-value" id="totalEvents">-</div></div>
			<div class="stat"><div class="stat-label">Used tools</div><div class="stat-value" id="usedTools">-</div></div>
			<div class="stat"><div class="stat-label">Error events</div><div class="stat-value" id="errorEvents">-</div></div>
		</section>
		<section class="toolbar">
			<input id="searchInput" type="search" placeholder="Search tool name">
			<select id="typeSelect">
				<option value="">All types</option>
				<option value="safe-critical">safe-critical</option>
				<option value="safe/wrapper">safe/wrapper</option>
				<option value="raw">raw</option>
			</select>
			<label class="check"><input id="usedOnly" type="checkbox"> Used only</label>
			<label class="check"><input id="errorsOnly" type="checkbox"> Errors only</label>
			<select id="pageSizeSelect">
				<option value="25">25 / page</option>
				<option value="50" selected>50 / page</option>
				<option value="100">100 / page</option>
				<option value="200">200 / page</option>
			</select>
			<button id="applyBtn">Apply</button>
			<button class="secondary" id="resetBtn">Reset</button>
		</section>
		<section class="table-wrap">
			<table>
				<colgroup>
					<col style="width: 33%">
					<col style="width: 13%">
					<col style="width: 9%">
					<col style="width: 10%">
					<col style="width: 10%">
					<col style="width: 11%">
					<col style="width: 14%">
				</colgroup>
				<thead>
					<tr>
						<th>Tool</th>
						<th>Type</th>
						<th>Count</th>
						<th>Success</th>
						<th>Error</th>
						<th>Avg ms</th>
						<th>Last used</th>
					</tr>
				</thead>
				<tbody id="rows"><tr><td colspan="7" class="loading">Loading...</td></tr></tbody>
			</table>
			<div class="footer">
				<div class="subtle" id="pageInfo">-</div>
				<div class="pages">
					<button class="secondary" id="prevBtn" title="Previous page">&lt;</button>
					<span id="pageNow">-</span>
					<button class="secondary" id="nextBtn" title="Next page">&gt;</button>
				</div>
			</div>
		</section>
	</main>
	<script>
		const state = {
			page: 1,
			pageSize: 50,
			allRows: [],
			filteredRows: [],
			meta: null,
		};
		const els = {
			caption: document.getElementById("caption"),
			totalTools: document.getElementById("totalTools"),
			totalEvents: document.getElementById("totalEvents"),
			usedTools: document.getElementById("usedTools"),
			errorEvents: document.getElementById("errorEvents"),
			searchInput: document.getElementById("searchInput"),
			typeSelect: document.getElementById("typeSelect"),
			usedOnly: document.getElementById("usedOnly"),
			errorsOnly: document.getElementById("errorsOnly"),
			pageSizeSelect: document.getElementById("pageSizeSelect"),
			rows: document.getElementById("rows"),
			pageInfo: document.getElementById("pageInfo"),
			pageNow: document.getElementById("pageNow"),
			refreshBtn: document.getElementById("refreshBtn"),
			applyBtn: document.getElementById("applyBtn"),
			resetBtn: document.getElementById("resetBtn"),
			prevBtn: document.getElementById("prevBtn"),
			nextBtn: document.getElementById("nextBtn"),
		};

		els.refreshBtn.addEventListener("click", loadAll);
		els.applyBtn.addEventListener("click", () => { state.page = 1; applyFilters(); });
		els.resetBtn.addEventListener("click", resetFilters);
		els.prevBtn.addEventListener("click", () => { if (state.page > 1) { state.page--; render(); } });
		els.nextBtn.addEventListener("click", () => {
			const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / state.pageSize));
			if (state.page < totalPages) { state.page++; render(); }
		});
		els.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") { state.page = 1; applyFilters(); }
		});
		els.pageSizeSelect.addEventListener("change", () => {
			state.pageSize = Number(els.pageSizeSelect.value);
			state.page = 1;
			render();
		});

		loadAll();

		async function loadAll() {
			els.caption.textContent = "Loading usage summary...";
			els.rows.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';
			const first = await fetchJson("/mcp-usage/summary?page=1&pageSize=200");
			const rows = [...first.rows];
			for (let page = 2; page <= first.totalPages; page++) {
				const next = await fetchJson("/mcp-usage/summary?page=" + page + "&pageSize=200");
				rows.push(...next.rows);
			}
			state.meta = first;
			state.allRows = rows;
			state.page = 1;
			applyFilters();
		}

		async function fetchJson(url) {
			const response = await fetch(url, { headers: { Accept: "application/json" } });
			if (!response.ok) throw new Error(await response.text());
			return response.json();
		}

		function applyFilters() {
			const term = els.searchInput.value.trim().toLowerCase();
			const type = els.typeSelect.value;
			state.pageSize = Number(els.pageSizeSelect.value);
			state.filteredRows = state.allRows.filter((row) => {
				if (term && !row.toolName.toLowerCase().includes(term)) return false;
				if (type && row.type !== type) return false;
				if (els.usedOnly.checked && row.count === 0) return false;
				if (els.errorsOnly.checked && row.errorCount === 0) return false;
				return true;
			});
			render();
		}

		function resetFilters() {
			els.searchInput.value = "";
			els.typeSelect.value = "";
			els.usedOnly.checked = false;
			els.errorsOnly.checked = false;
			els.pageSizeSelect.value = "50";
			state.page = 1;
			applyFilters();
		}

		function render() {
			const used = state.allRows.filter((row) => row.count > 0).length;
			const errors = state.allRows.reduce((sum, row) => sum + row.errorCount, 0);
			els.totalTools.textContent = formatNumber(state.meta?.totalTools || state.allRows.length);
			els.totalEvents.textContent = formatNumber(state.meta?.totalEvents || 0);
			els.usedTools.textContent = formatNumber(used);
			els.errorEvents.textContent = formatNumber(errors);
			els.caption.textContent = "Showing " + formatNumber(state.filteredRows.length) + " tools, sorted by usage count";

			const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / state.pageSize));
			state.page = Math.min(state.page, totalPages);
			const start = (state.page - 1) * state.pageSize;
			const pageRows = state.filteredRows.slice(start, start + state.pageSize);
			els.rows.innerHTML = pageRows.length
				? pageRows.map(rowHtml).join("")
				: '<tr><td colspan="7" class="empty">No matching tools</td></tr>';
			els.pageInfo.textContent = "Rows " + (pageRows.length ? start + 1 : 0) + "-" + (start + pageRows.length) + " of " + state.filteredRows.length;
			els.pageNow.textContent = state.page + " / " + totalPages;
			els.prevBtn.disabled = state.page <= 1;
			els.nextBtn.disabled = state.page >= totalPages;
		}

		function rowHtml(row) {
			const badgeClass = row.type === "safe-critical" ? "critical" : row.type === "safe/wrapper" ? "safe" : "";
			return "<tr>" +
				"<td class='tool'>" + escapeHtml(row.toolName) + "</td>" +
				"<td><span class='badge " + badgeClass + "'>" + escapeHtml(row.type) + "</span></td>" +
				"<td>" + formatNumber(row.count) + "</td>" +
				"<td class='ok'>" + formatNumber(row.successCount) + "</td>" +
				"<td class='" + (row.errorCount ? "err" : "") + "'>" + formatNumber(row.errorCount) + "</td>" +
				"<td>" + formatNumber(row.avgDurationMs) + "</td>" +
				"<td>" + formatDate(row.lastUsedAt) + "</td>" +
				"</tr>";
		}

		function formatDate(value) {
			if (!value) return "-";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			return date.toLocaleString();
		}

		function formatNumber(value) {
			return Number(value || 0).toLocaleString();
		}

		function escapeHtml(value) {
			return String(value)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		}
	</script>
</body>
</html>`;
}
