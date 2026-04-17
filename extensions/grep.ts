import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createInterface } from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveRipgrepPath, assertDirectory, safeMtime } from "./lib/ripgrep.js";

const LIMIT = 100;
const MAX_LINE_LENGTH = 2000;
const DEFAULT_IGNORE_GLOBS = ["!**/.git/**", "!**/node_modules/**", "!**/background-agents/**", "!**/state/**", "!**/*.jsonl", "!**/*.log"];

const schema = Type.Object({
  pattern: Type.String({ description: "The regex pattern to search for in file contents" }),
  path: Type.Optional(Type.String({ description: "The directory to search in. Defaults to the current working directory." })),
  include: Type.Optional(Type.String({ description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")' })),
});

type MatchRecord = {
  path: string;
  modTime: number;
  lineNum: number;
  lineText: string;
};

type ResultDetails = {
  matches: number;
  truncated: boolean;
  searchPath: string;
};

type MatchSearchResult = {
  lines: string[];
  truncated: boolean;
  exitCode: number;
  stderr: string;
  hadSkippedPaths: boolean;
};

async function collectMatchLines(
  rgPath: string,
  searchPath: string,
  pattern: string,
  include: string | undefined,
  signal?: AbortSignal,
) {
  const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", pattern];
  for (const glob of DEFAULT_IGNORE_GLOBS) args.push("--glob", glob);
  if (include) args.push("--glob", include);
  args.push(searchPath);

  return new Promise<MatchSearchResult>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: searchPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout! });
    const lines: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;
    let truncated = false;
    let stoppedEarly = false;

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const stop = () => {
      stoppedEarly = true;
      if (!child.killed) child.kill();
    };

    const onAbort = () => {
      stop();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    rl.on("line", (line) => {
      if (!line) return;
      if (lines.length >= LIMIT) {
        truncated = true;
        stop();
        return;
      }
      lines.push(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrChunks.join("").length >= 8192) return;
      stderrChunks.push(chunk.toString());
    });

    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() =>
        resolve({
          lines,
          truncated,
          exitCode: stoppedEarly ? 0 : code ?? 0,
          stderr: stderrChunks.join("").trim(),
          hadSkippedPaths: !stoppedEarly && (code ?? 0) === 2 && lines.length > 0,
        }),
      ),
    );
  });
}

function resultSummary(result: { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> }) {
  const details = result.details ?? {};
  const firstLine = result.content?.find((entry) => entry.type === "text")?.text?.split("\n").find(Boolean) ?? "Done";
  if (typeof details.matches === "number") {
    return `${details.matches}${details.truncated ? "+" : ""} results${details.truncated ? " [truncated]" : ""}`;
  }
  return firstLine;
}

export default function grepExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description:
      "Fast content search across your codebase. Supports full regex syntax and file pattern filtering.",
    promptSnippet: "Search file contents using regular expressions.",
    promptGuidelines: [
      "Use this tool when you need to find files containing specific patterns.",
      "Use the include parameter to filter files by pattern, for example '*.js' or '*.{ts,tsx}'.",
      "If you need to identify or count every match within files, use bash with rg directly instead of this tool.",
      "When you are doing an open-ended search that may require multiple rounds of globbing and grepping, prefer the task tool instead.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = path.resolve(ctx.cwd, params.path || ".");
      await assertDirectory(searchPath);

      const rgPath = await resolveRipgrepPath();
      const { lines, truncated, exitCode, stderr, hadSkippedPaths } = await collectMatchLines(
        rgPath,
        searchPath,
        params.pattern,
        params.include,
        signal,
      );

      if (exitCode === 1 && lines.length === 0) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: { matches: 0, truncated: false, searchPath } satisfies ResultDetails,
        };
      }
      if (exitCode !== 0 && exitCode !== 2) {
        throw new Error(`ripgrep failed: ${stderr.trim() || `exit code ${exitCode}`}`);
      }
      if (exitCode === 2 && lines.length === 0) {
        throw new Error(`ripgrep failed: ${stderr.trim() || "invalid search pattern or inaccessible path"}`);
      }

      const matches: MatchRecord[] = [];
      for (const line of lines) {
        if (!line) continue;
        const [filePath, lineNumText, ...lineTextParts] = line.split("|");
        if (!filePath || !lineNumText || lineTextParts.length === 0) continue;

        const lineNum = Number.parseInt(lineNumText, 10);
        if (Number.isNaN(lineNum)) continue;

        matches.push({
          path: filePath,
          modTime: await safeMtime(filePath),
          lineNum,
          lineText: lineTextParts.join("|"),
        });
      }

      matches.sort((a, b) => b.modTime - a.modTime);
      const visible = matches.slice(0, LIMIT);

      if (visible.length === 0) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: { matches: 0, truncated: false, searchPath } satisfies ResultDetails,
        };
      }

      const output = [truncated ? `Found more than ${LIMIT} matches (showing first ${LIMIT})` : `Found ${matches.length} matches`];
      let currentFile = "";

      for (const match of visible) {
        if (currentFile !== match.path) {
          if (currentFile) output.push("");
          currentFile = match.path;
          output.push(`${match.path}:`);
        }
        const lineText =
          match.lineText.length > MAX_LINE_LENGTH ? `${match.lineText.slice(0, MAX_LINE_LENGTH)}...` : match.lineText;
        output.push(`  Line ${match.lineNum}: ${lineText}`);
      }

      if (truncated) {
        output.push("");
        output.push(`(Results truncated at ${LIMIT} matches. Consider using a more specific path or pattern.)`);
      }
      if (hadSkippedPaths) {
        output.push("");
        output.push("(Some paths were inaccessible and skipped)");
      }

      return {
        content: [{ type: "text", text: output.join("\n") }],
        details: {
          matches: visible.length,
          truncated,
          searchPath,
        } satisfies ResultDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("grep "))}${theme.fg("accent", args.pattern)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      return new Text(theme.fg("success", resultSummary(result as { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> })), 0, 0);
    },
  });
}
