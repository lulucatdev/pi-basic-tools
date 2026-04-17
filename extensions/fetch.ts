/**
 * Fetch Extension
 *
 * Registers a `fetch` tool that retrieves content from a URL and returns it
 * as plain text, markdown, or raw HTML.  HTML responses are converted to
 * markdown or stripped to plain text on the fly.
 *
 * Ported from opencode's fetch tool, adapted for the pi extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const fetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from (must start with http:// or https://)" }),
	format: Type.Optional(
		Type.Union(
			[Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")],
			{ description: "Output format: text (default), markdown, or html", default: "markdown" },
		),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Request timeout in seconds (default 30, max 120)" }),
	),
});

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Minimal HTML-to-text: strip all tags, collapse whitespace.
 */
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Lightweight HTML-to-markdown conversion.
 * Handles headings, paragraphs, links, code blocks, lists, bold, italic.
 * Not a full converter — sufficient for documentation and article pages.
 */
function htmlToMarkdown(html: string): string {
	let md = html;

	// Remove script and style blocks
	md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
	md = md.replace(/<style[\s\S]*?<\/style>/gi, "");

	// Headings
	md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
	md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
	md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
	md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
	md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
	md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

	// Code blocks
	md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
	md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
	md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

	// Bold / italic
	md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
	md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

	// Links
	md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

	// Images
	md = md.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
	md = md.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

	// Lists
	md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
	md = md.replace(/<\/?[ou]l[^>]*>/gi, "\n");

	// Paragraphs and breaks
	md = md.replace(/<br\s*\/?>/gi, "\n");
	md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
	md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");

	// Horizontal rules
	md = md.replace(/<hr[^>]*\/?>/gi, "\n---\n");

	// Strip remaining tags
	md = md.replace(/<[^>]+>/g, "");

	// Decode common entities
	md = md.replace(/&nbsp;/g, " ");
	md = md.replace(/&amp;/g, "&");
	md = md.replace(/&lt;/g, "<");
	md = md.replace(/&gt;/g, ">");
	md = md.replace(/&quot;/g, '"');
	md = md.replace(/&#39;/g, "'");

	// Collapse excessive blank lines
	md = md.replace(/\n{3,}/g, "\n\n");

	return md.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		label: "fetch",
		description:
			"Fetch content from a URL and return it as text, markdown, or HTML. " +
			"Useful for retrieving documentation, API responses, or web content.",
		parameters: fetchSchema,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const url: string = params.url;
			const format: string = params.format ?? "markdown";
			const timeoutSec: number = Math.min(params.timeout ?? 30, 120);

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			if (!["text", "markdown", "html"].includes(format)) {
				throw new Error("Format must be one of: text, markdown, html");
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

			// Forward parent signal
			if (signal) {
				signal.addEventListener("abort", () => controller.abort(), { once: true });
			}

			try {
				const response = await fetch(url, {
					signal: controller.signal,
					headers: { "User-Agent": "pi-goodstuff/1.0" },
					redirect: "follow",
				});

				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText}`);
				}

				const contentLength = response.headers.get("content-length");
				if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
					throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`);
				}

				const body = await response.text();
				if (body.length > MAX_RESPONSE_BYTES) {
					throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				const isHTML = contentType.includes("text/html");

				let output: string;
				switch (format) {
					case "text":
						output = isHTML ? htmlToText(body) : body;
						break;
					case "markdown":
						output = isHTML ? htmlToMarkdown(body) : body;
						break;
					case "html":
						output = body;
						break;
					default:
						output = body;
				}

				return {
					content: [{ type: "text" as const, text: output }],
				};
			} finally {
				clearTimeout(timeout);
			}
		},
	});
}
