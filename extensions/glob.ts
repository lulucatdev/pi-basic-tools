import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createInterface } from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveRipgrepPath, assertDirectory, safeMtime } from "./lib/ripgrep.js";

const LIMIT = 100;

const schema = Type.Object({
  pattern: Type.String({ description: "The glob pattern to match files against" }),
  path: Type.Optional(
    Type.String({
      description:
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    }),
  ),
});

type ResultDetails = {
  count: number;
  truncated: boolean;
  searchPath: string;
};

async function collectFileLines(searchPath: string, pattern: string, signal?: AbortSignal) {
  const rgPath = await resolveRipgrepPath();
  const args = ["--files", "--glob=!.git/*", "--hidden", `--glob=${pattern}`];

  return new Promise<{ lines: string[]; truncated: boolean }>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: searchPath,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout! });
    const lines: string[] = [];
    let truncated = false;
    let settled = false;

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
      lines.push(line.replace(/\\/g, "/"));
    });

    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => finish(() => resolve({ lines, truncated })));
  });
}

function resultSummary(result: { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> }) {
  const details = result.details ?? {};
  const firstLine = result.content?.find((entry) => entry.type === "text")?.text?.split("\n").find(Boolean) ?? "Done";
  if (typeof details.count === "number") {
    return `${details.count} results${details.truncated ? " [truncated]" : ""}`;
  }
  return firstLine;
}

export default function globExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "glob",
    label: "glob",
    description:
      "Search for files using glob patterns like '**/*.js' or 'src/**/*.ts'. Returns matching file paths sorted by modification time.",
    promptSnippet: "Find files by pattern matching.",
    promptGuidelines: [
      "Use this tool when you need to find files by name patterns.",
      "Supports glob patterns like '**/*.js' or 'src/**/*.ts'.",
      "Returns matching file paths sorted by modification time.",
      "When you are doing an open-ended search that may require multiple rounds of globbing and grepping, prefer the task tool instead.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = path.resolve(ctx.cwd, params.path || ".");
      await assertDirectory(searchPath);

      const { lines, truncated } = await collectFileLines(searchPath, params.pattern, signal);
      const files = await Promise.all(
        lines.map(async (relativePath) => ({
          path: path.resolve(searchPath, relativePath),
          mtime: await safeMtime(path.resolve(searchPath, relativePath)),
        })),
      );

      files.sort((a, b) => b.mtime - a.mtime);

      const output: string[] = [];
      if (files.length === 0) output.push("No files found");
      if (files.length > 0) {
        output.push(...files.map((file) => file.path));
        if (truncated) {
          output.push("");
          output.push(`(Results are truncated: showing first ${LIMIT} results. Consider using a more specific path or pattern.)`);
        }
      }

      return {
        content: [{ type: "text", text: output.join("\n") }],
        details: {
          count: files.length,
          truncated,
          searchPath,
        } satisfies ResultDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("glob "))}${theme.fg("accent", args.pattern)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      return new Text(theme.fg("success", resultSummary(result as { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> })), 0, 0);
    },
  });
}
