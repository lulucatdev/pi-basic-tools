/**
 * Fetch Extension
 *
 * Fetches a URL, stores the raw response under project-local `.pi/fetch/`, and
 * attempts to convert that stored file to Markdown with MarkItDown.
 */

import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const fetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from (must start with http:// or https://)" }),
	format: Type.Optional(
		Type.Union(
			[Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")],
			{
				description:
					"Preferred preview format for stored artifacts. The raw response is always saved and Markdown conversion is always attempted.",
				default: "markdown",
			},
		),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Request timeout in seconds (default 30, max 120)" }),
	),
});

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MARKITDOWN_TIMEOUT_MS = 30_000;
const FETCH_SCHEMA_VERSION = 1;

interface MarkitdownAttemptSummary {
	command: string;
	args: string[];
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

interface MarkitdownStatus {
	success: boolean;
	command?: string;
	attempts: MarkitdownAttemptSummary[];
	error?: string;
}

interface FetchArtifactMetadata {
	schemaVersion: number;
	id: string;
	url: string;
	requestedFormat: string;
	fetchedAt: string;
	contentType: string;
	responseBytes: number;
	paths: {
		artifactDir: string;
		rawPath: string;
		markdownPath?: string;
	};
	converter: {
		name: "markitdown";
		success: boolean;
		command?: string;
		error?: string;
		attempts: MarkitdownAttemptSummary[];
	};
}

interface FetchDetails {
	id: string;
	url: string;
	contentType: string;
	responseBytes: number;
	artifactDir: string;
	artifactDirDisplay: string;
	rawPath: string;
	rawPathDisplay: string;
	markdownPath?: string;
	markdownPathDisplay?: string;
	metadataPath: string;
	metadataPathDisplay: string;
	markitdown: MarkitdownStatus;
}

function slugify(text: string, maxLen = 64): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		.replace(/-+$/g, "");
	return slug || "fetch";
}

function formatTimestamp(date = new Date()): string {
	return [
		date.getFullYear().toString(),
		(date.getMonth() + 1).toString().padStart(2, "0"),
		date.getDate().toString().padStart(2, "0"),
		date.getHours().toString().padStart(2, "0"),
		date.getMinutes().toString().padStart(2, "0"),
		date.getSeconds().toString().padStart(2, "0"),
	].join("");
}

function buildFetchLabel(url: string): string {
	const parsed = new URL(url);
	const pathParts = parsed.pathname.split("/").filter(Boolean).slice(-3);
	const label = [parsed.hostname, ...pathParts];
	if (parsed.search) label.push("query");
	return label.join("-") || parsed.hostname || "fetch";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function ensureProjectRoot(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		if (await pathExists(join(current, ".pi"))) return current;
		if (await pathExists(join(current, ".git"))) return current;
		const parent = resolve(current, "..");
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

async function createArtifactDir(rootDir: string, label: string): Promise<{ id: string; dir: string }> {
	await mkdir(rootDir, { recursive: true });
	const baseId = `${formatTimestamp()}-${slugify(label)}`;
	let candidateId = baseId;
	for (let suffix = 2; ; suffix += 1) {
		const candidateDir = join(rootDir, candidateId);
		try {
			await mkdir(candidateDir);
			return { id: candidateId, dir: candidateDir };
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			candidateId = `${baseId}-${suffix}`;
		}
	}
}

function inferRawExtension(url: string, contentType: string): string {
	const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (normalized.includes("text/html")) return ".html";
	if (normalized.includes("application/json")) return ".json";
	if (normalized.includes("application/pdf")) return ".pdf";
	if (normalized.includes("application/zip")) return ".zip";
	if (normalized.includes("application/epub+zip")) return ".epub";
	if (normalized.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) return ".docx";
	if (normalized.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation")) return ".pptx";
	if (normalized.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) return ".xlsx";
	if (normalized.includes("application/msword")) return ".doc";
	if (normalized.includes("application/vnd.ms-powerpoint")) return ".ppt";
	if (normalized.includes("application/vnd.ms-excel")) return ".xls";
	if (normalized.includes("text/markdown")) return ".md";
	if (normalized.includes("text/plain")) return ".txt";
	if (normalized.includes("application/xml") || normalized.includes("text/xml")) return ".xml";
	if (normalized.includes("text/csv")) return ".csv";

	const pathname = new URL(url).pathname;
	const fromUrl = extname(pathname).toLowerCase();
	if (fromUrl && /^[.a-z0-9_-]+$/.test(fromUrl)) return fromUrl;
	return ".html";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toDisplayPath(projectRoot: string, absolutePath: string): string {
	const rel = relative(projectRoot, absolutePath);
	if (!rel || rel.startsWith("..") || rel === "") return absolutePath;
	return rel;
}

function trimCommandOutput(text: string, maxChars = 1200): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}...`;
}

async function removeIfExists(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
}

async function runMarkitdown(
	pi: ExtensionAPI,
	inputPath: string,
	outputPath: string,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<MarkitdownStatus> {
	const candidates = [
		...(process.env.HOME ? [{ command: join(process.env.HOME, ".local", "bin", "markitdown"), args: [inputPath, "-o", outputPath] }] : []),
		{ command: "markitdown", args: [inputPath, "-o", outputPath] },
		{ command: "python3", args: ["-m", "markitdown", inputPath, "-o", outputPath] },
		{ command: "python", args: ["-m", "markitdown", inputPath, "-o", outputPath] },
	];
	const attempts: MarkitdownAttemptSummary[] = [];

	for (const candidate of candidates) {
		await removeIfExists(outputPath);
		const result: ExecResult = await pi.exec(candidate.command, candidate.args, {
			cwd,
			signal,
			timeout: timeoutMs,
		});
		attempts.push({
			command: candidate.command,
			args: candidate.args,
			code: result.code,
			killed: result.killed,
			stdout: trimCommandOutput(result.stdout),
			stderr: trimCommandOutput(result.stderr),
		});
		if (result.code === 0 && (await pathExists(outputPath))) {
			return {
				success: true,
				command: [candidate.command, ...candidate.args].join(" "),
				attempts,
			};
		}
	}

	return {
		success: false,
		attempts,
		error: "MarkItDown conversion failed or is unavailable on this machine.",
	};
}

function buildResultText(details: FetchDetails): string {
	const lines = [
		`Fetched URL: ${details.url}`,
		`Size: ${formatBytes(details.responseBytes)}`,
		`Artifacts: ${details.artifactDirDisplay}`,
		`Raw response: ${details.rawPathDisplay}`,
		details.markdownPathDisplay
			? `Markdown: ${details.markdownPathDisplay}`
			: "Markdown: conversion failed; see metadata for MarkItDown attempts.",
		`Metadata: ${details.metadataPathDisplay}`,
		details.markitdown.success
			? `MarkItDown: success (${details.markitdown.command})`
			: `MarkItDown: failed (${details.markitdown.error ?? "unknown error"})`,
		details.markdownPathDisplay
			? `Next: use read on ${details.markdownPathDisplay}`
			: `Next: use read on ${details.rawPathDisplay}`,
	];
	return lines.join("\n");
}

function renderSummary(details: FetchDetails, theme: any): string {
	const lines: string[] = [];
	lines.push(theme.fg("success", "Fetched"));
	if (details.contentType) lines[0] += theme.fg("dim", ` ${details.contentType}`);
	lines.push(theme.fg("dim", `Size: ${formatBytes(details.responseBytes)}`));
	lines.push(theme.fg("dim", `Dir: ${details.artifactDirDisplay}`));
	lines.push(theme.fg("dim", `Raw: ${details.rawPathDisplay}`));
	if (details.markdownPathDisplay) {
		lines.push(theme.fg("dim", `Markdown: ${details.markdownPathDisplay}`));
		lines.push(theme.fg("dim", `Next: read ${details.markdownPathDisplay}`));
	} else {
		lines.push(theme.fg("warning", "Markdown: conversion failed"));
		lines.push(theme.fg("dim", `Next: read ${details.rawPathDisplay}`));
	}
	lines.push(theme.fg("dim", `Metadata: ${details.metadataPathDisplay}`));
	if (details.markitdown.success) {
		lines.push(theme.fg("dim", `MarkItDown: ${details.markitdown.command}`));
	} else {
		lines.push(theme.fg("warning", `MarkItDown: ${details.markitdown.error ?? "failed"}`));
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		label: "fetch",
		description:
			"Fetch a URL, store the raw response under project-local .pi/fetch/, and attempt Markdown conversion with MarkItDown. " +
			"Returns the saved artifact paths instead of inlining the page body.",
		parameters: fetchSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url: string = params.url;
			const requestedFormat: string = params.format ?? "markdown";
			const timeoutSec: number = Math.min(params.timeout ?? 30, 120);

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			if (!["text", "markdown", "html"].includes(requestedFormat)) {
				throw new Error("Format must be one of: text, markdown, html");
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);
			if (signal) {
				signal.addEventListener("abort", () => controller.abort(), { once: true });
			}

			try {
				const response = await fetch(url, {
					signal: controller.signal,
					headers: { "User-Agent": "pi-basic-tools/1.0" },
					redirect: "follow",
				});

				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText}`);
				}

				const contentLength = response.headers.get("content-length");
				if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
					throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`);
				}

				const buffer = Buffer.from(await response.arrayBuffer());
				if (buffer.byteLength > MAX_RESPONSE_BYTES) {
					throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				const projectRoot = await ensureProjectRoot(ctx.cwd);
				const fetchRoot = join(projectRoot, ".pi", "fetch");
				const artifact = await createArtifactDir(fetchRoot, buildFetchLabel(url));
				const rawFilename = `response${inferRawExtension(url, contentType)}`;
				const rawPath = join(artifact.dir, rawFilename);
				const markdownPath = join(artifact.dir, "content.md");
				const metadataPath = join(artifact.dir, "meta.json");

				await writeFile(rawPath, buffer);
				const markitdown = await runMarkitdown(
					pi,
					rawPath,
					markdownPath,
					projectRoot,
					controller.signal,
					Math.max(timeoutSec * 1000, MARKITDOWN_TIMEOUT_MS),
				);

				const details: FetchDetails = {
					id: artifact.id,
					url,
					contentType,
					responseBytes: buffer.byteLength,
					artifactDir: artifact.dir,
					artifactDirDisplay: toDisplayPath(projectRoot, artifact.dir),
					rawPath,
					rawPathDisplay: toDisplayPath(projectRoot, rawPath),
					markdownPath: markitdown.success ? markdownPath : undefined,
					markdownPathDisplay: markitdown.success ? toDisplayPath(projectRoot, markdownPath) : undefined,
					metadataPath,
					metadataPathDisplay: toDisplayPath(projectRoot, metadataPath),
					markitdown,
				};

				const metadata: FetchArtifactMetadata = {
					schemaVersion: FETCH_SCHEMA_VERSION,
					id: artifact.id,
					url,
					requestedFormat,
					fetchedAt: new Date().toISOString(),
					contentType,
					responseBytes: buffer.byteLength,
					paths: {
						artifactDir: artifact.dir,
						rawPath,
						markdownPath: markitdown.success ? markdownPath : undefined,
					},
					converter: {
						name: "markitdown",
						success: markitdown.success,
						command: markitdown.command,
						error: markitdown.error,
						attempts: markitdown.attempts,
					},
				};
				await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

				return {
					content: [{ type: "text" as const, text: buildResultText(details) }],
					details,
				};
			} finally {
				clearTimeout(timeout);
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("fetch "));
			const previewUrl = args.url.length > 80 ? `${args.url.slice(0, 77)}...` : args.url;
			text += theme.fg("accent", previewUrl);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as FetchDetails | undefined;
			if (!details) {
				const content = result.content.find((item) => item.type === "text");
				return new Text(content?.type === "text" ? content.text : theme.fg("error", "No output"), 0, 0);
			}

			return new Text(renderSummary(details, theme), 0, 0);
		},
	});
}
