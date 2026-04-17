/**
 * Sourcegraph Extension
 *
 * Registers a `sourcegraph` tool that searches code across public repositories
 * via the Sourcegraph GraphQL API.  No API key required.
 *
 * Ported from opencode's sourcegraph tool, adapted for the pi extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const sourcegraphSchema = Type.Object({
	query: Type.String({
		description:
			"Sourcegraph search query. Supports: repo:, file:, lang:, type:symbol, " +
			"Boolean operators (AND/OR/NOT), regex patterns. " +
			'Examples: "file:.go context.WithTimeout", "lang:typescript useState type:symbol"',
	}),
	count: Type.Optional(
		Type.Number({ description: "Number of results to return (default 10, max 20)" }),
	),
	context_window: Type.Optional(
		Type.Number({ description: "Lines of context around each match (default 10)" }),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Request timeout in seconds (default 30, max 120)" }),
	),
});

const GRAPHQL_ENDPOINT = "https://sourcegraph.com/.api/graphql";

const SEARCH_QUERY = `query Search($query: String!) {
  search(query: $query, version: V2, patternType: keyword) {
    results {
      matchCount
      limitHit
      resultCount
      approximateResultCount
      results {
        __typename
        ... on FileMatch {
          repository { name }
          file { path, url, content }
          lineMatches { preview, lineNumber, offsetAndLengths }
        }
      }
    }
  }
}`;

interface FileMatch {
	__typename: string;
	repository: { name: string };
	file: { path: string; url: string; content: string };
	lineMatches: Array<{ preview: string; lineNumber: number; offsetAndLengths: number[][] }>;
}

interface SearchResults {
	matchCount: number;
	limitHit: boolean;
	resultCount: number;
	approximateResultCount: string;
	results: FileMatch[];
}

function formatResults(searchResults: SearchResults, contextWindow: number): string {
	const lines: string[] = [];

	lines.push("# Sourcegraph Search Results");
	lines.push("");
	lines.push(`Found ${searchResults.matchCount} matches across ${searchResults.resultCount} results`);
	if (searchResults.limitHit) {
		lines.push("(Result limit reached — try a more specific query)");
	}
	lines.push("");

	const fileMatches = searchResults.results.filter(
		(r) => r.__typename === "FileMatch" && r.repository && r.file,
	);

	if (fileMatches.length === 0) {
		lines.push("No file matches found. Try a different query.");
		return lines.join("\n");
	}

	const maxResults = 10;
	const display = fileMatches.slice(0, maxResults);

	for (let i = 0; i < display.length; i++) {
		const match = display[i];
		const repoName = match.repository.name;
		const filePath = match.file.path;
		const fileURL = match.file.url;
		const fileContent = match.file.content;

		lines.push(`## Result ${i + 1}: ${repoName}/${filePath}`);
		if (fileURL) {
			lines.push(`URL: https://sourcegraph.com${fileURL}`);
		}
		lines.push("");

		if (match.lineMatches && match.lineMatches.length > 0) {
			for (const lm of match.lineMatches) {
				const lineNumber = lm.lineNumber;

				if (fileContent) {
					const contentLines = fileContent.split("\n");
					lines.push("```");

					const startLine = Math.max(0, lineNumber - contextWindow);
					for (let j = startLine; j < lineNumber && j < contentLines.length; j++) {
						lines.push(`${j + 1}| ${contentLines[j]}`);
					}
					lines.push(`${lineNumber + 1}|  ${lm.preview}`);
					const endLine = Math.min(contentLines.length, lineNumber + 1 + contextWindow);
					for (let j = lineNumber + 1; j < endLine; j++) {
						lines.push(`${j + 1}| ${contentLines[j]}`);
					}

					lines.push("```");
					lines.push("");
				} else {
					lines.push("```");
					lines.push(`${lineNumber + 1}| ${lm.preview}`);
					lines.push("```");
					lines.push("");
				}
			}
		}
	}

	if (fileMatches.length > maxResults) {
		lines.push(`... and ${fileMatches.length - maxResults} more results`);
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sourcegraph",
		label: "sourcegraph",
		description:
			"Search code across public repositories using the Sourcegraph API. " +
			"Supports repo/file/language filters, regex, symbol search, and Boolean operators. " +
			"No API key required. Useful for finding reference implementations, API usage examples, " +
			"and patterns in open-source code.",
		parameters: sourcegraphSchema,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const query: string = params.query;
			let count: number = params.count ?? 10;
			const contextWindow: number = params.context_window ?? 10;
			const timeoutSec: number = Math.min(params.timeout ?? 30, 120);

			if (!query) {
				throw new Error("query parameter is required");
			}

			if (count <= 0) count = 10;
			if (count > 20) count = 20;

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);
			if (signal) {
				signal.addEventListener("abort", () => controller.abort(), { once: true });
			}

			try {
				const response = await fetch(GRAPHQL_ENDPOINT, {
					method: "POST",
					signal: controller.signal,
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "pi-basic-tools/1.0",
					},
					body: JSON.stringify({
						query: SEARCH_QUERY,
						variables: { query: `${query} count:${count}` },
					}),
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					throw new Error(
						`Sourcegraph API returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
					);
				}

				const result = await response.json();

				if (result.errors && result.errors.length > 0) {
					const messages = result.errors.map((e: { message: string }) => e.message).join("; ");
					throw new Error(`Sourcegraph API error: ${messages}`);
				}

				const searchResults: SearchResults = result?.data?.search?.results;
				if (!searchResults) {
					throw new Error("Unexpected response format from Sourcegraph API");
				}

				const output = formatResults(searchResults, contextWindow);

				return {
					content: [{ type: "text" as const, text: output }],
				};
			} finally {
				clearTimeout(timeout);
			}
		},
	});
}
