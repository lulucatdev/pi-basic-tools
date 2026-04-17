import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createInterface } from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveRipgrepPath, assertDirectory } from "./lib/ripgrep.js";

const LIMIT = 100;
const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
];

const schema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "The absolute path to the directory to list (must be absolute, not relative)" }),
  ),
  ignore: Type.Optional(Type.Array(Type.String({ description: "List of glob patterns to ignore" }))),
});

type ResultDetails = {
  count: number;
  truncated: boolean;
  searchPath: string;
};

async function collectFileLines(searchPath: string, globs: string[], signal?: AbortSignal) {
  const rgPath = await resolveRipgrepPath();
  const args = ["--files", "--glob=!.git/*", "--hidden", ...globs.map((glob) => `--glob=${glob}`)];

  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: searchPath,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout! });
    const lines: string[] = [];
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
      lines.push(line.replace(/\\/g, "/"));
      if (lines.length >= LIMIT) stop();
    });

    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => finish(() => resolve(lines.slice(0, LIMIT))));
  });
}

function uniqueSorted(values: Iterable<string>) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function resultSummary(result: { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> }) {
  const details = result.details ?? {};
  const firstLine = result.content?.find((entry) => entry.type === "text")?.text?.split("\n").find(Boolean) ?? "Done";
  if (typeof details.count === "number") {
    return `${details.count} results${details.truncated ? " [truncated]" : ""}`;
  }
  return firstLine;
}

export default function listExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list",
    label: "list",
    description: "This tool lists directory contents. It accepts glob patterns to filter results.",
    promptSnippet: "List files and directories in a given path.",
    promptGuidelines: [
      "The path parameter should be an absolute path; omit it to use the current workspace directory.",
      "You can optionally provide an array of glob patterns to ignore with the ignore parameter.",
      "Prefer the glob and grep tools when you already know which directories you want to search.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = path.resolve(ctx.cwd, params.path || ".");
      await assertDirectory(searchPath);

      const ignoreGlobs = DEFAULT_IGNORE_PATTERNS.map((pattern) => `!${pattern}*`).concat(
        (params.ignore ?? []).map((pattern) => `!${pattern}`),
      );
      const files = await collectFileLines(searchPath, ignoreGlobs, signal);

      const dirs = new Set<string>();
      const filesByDir = new Map<string, string[]>();

      for (const file of files) {
        const normalized = file.replace(/\\/g, "/");
        const dirPath = path.posix.dirname(normalized);
        const parts = dirPath === "." ? [] : dirPath.split("/");

        for (let index = 0; index <= parts.length; index += 1) {
          const parent = index === 0 ? "." : parts.slice(0, index).join("/");
          dirs.add(parent);
        }

        const bucket = filesByDir.get(dirPath) ?? [];
        bucket.push(path.posix.basename(normalized));
        filesByDir.set(dirPath, bucket);
      }

      const renderDir = (dirPath: string, depth: number): string => {
        const indent = " ".repeat(depth);
        let output = "";

        if (depth > 0) output += `${indent}${path.posix.basename(dirPath)}/\n`;

        const children = uniqueSorted(
          Array.from(dirs).filter((candidate) => path.posix.dirname(candidate) === dirPath && candidate !== dirPath),
        );

        for (const child of children) {
          output += renderDir(child, depth + 1);
        }

        for (const file of uniqueSorted(filesByDir.get(dirPath) ?? [])) {
          output += `${" ".repeat(depth + 1)}${file}\n`;
        }

        return output;
      };

      return {
        content: [{ type: "text", text: `${searchPath}/\n${renderDir(".", 0)}` }],
        details: {
          count: files.length,
          truncated: files.length >= LIMIT,
          searchPath,
        } satisfies ResultDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("list "))}${theme.fg("accent", args.path || ".")}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      return new Text(theme.fg("success", resultSummary(result as { content?: Array<{ type: string; text?: string }>; details?: Partial<ResultDetails> })), 0, 0);
    },
  });
}
