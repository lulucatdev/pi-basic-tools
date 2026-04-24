import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

type GitRunBufferResult = {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

const checkpointSchema = Type.Object({
  label: Type.Optional(Type.String({ description: "Optional human-readable checkpoint label" })),
  description: Type.Optional(Type.String({ description: "Optional checkpoint description saved in metadata" })),
  includeUntracked: Type.Optional(Type.Boolean({ description: "Include untracked files in the saved patch when possible (default true)" })),
  maxBytes: Type.Optional(Type.Number({ description: "Maximum patch bytes to save (default 5000000, max 20000000)" })),
});

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, "utf8");
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[Output truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

function runGit(args: string[], cwd: string, signal?: AbortSignal, maxBytes = 120_000): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stopForLimit = () => {
      truncated = true;
      if (!child.killed) child.kill();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxBytes) {
        stopForLimit();
      }
    };
    const onAbort = () => {
      if (!child.killed) child.kill();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      const out = truncateOutput(stdout, maxBytes);
      const err = truncateOutput(stderr, Math.max(8192, Math.floor(maxBytes / 4)));
      finish(() => resolve({ stdout: out.text, stderr: err.text, exitCode: truncated ? 0 : code ?? 0, truncated: truncated || out.truncated || err.truncated }));
    });
  });
}

function runGitBuffer(args: string[], cwd: string, signal?: AbortSignal, maxBytes = 120_000): Promise<GitRunBufferResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let truncated = false;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stopForLimit = () => {
      truncated = true;
      if (!child.killed) child.kill();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdoutChunks.push(chunk);
      else stderrChunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) stopForLimit();
    };
    const onAbort = () => {
      if (!child.killed) child.kill();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
      const err = truncateOutput(stderrRaw, Math.max(8192, Math.floor(maxBytes / 4)));
      const limitedStdout = stdout.length > maxBytes ? stdout.subarray(0, maxBytes) : stdout;
      finish(() => resolve({ stdout: limitedStdout, stderr: err.text, exitCode: truncated ? 0 : code ?? 0, truncated: truncated || stdout.length > maxBytes || err.truncated }));
    });
  });
}

async function ensureGitRepo(cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd, signal, 20_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Not inside a git repository");
  }
  return result.stdout.trim();
}

async function hasGitHead(root: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], root, signal, 20_000);
  return result.exitCode === 0;
}

async function optionalGitOutput(args: string[], root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(args, root, signal, 40_000);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function parseGitStatus(stdout: string): Array<{ status: string; path: string }> {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const status = line.slice(0, 2).trim() || "??";
    const filePath = line.length > 3 ? line.slice(3) : line.trim();
    return { status, path: filePath };
  });
}

function isCheckpointStoragePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === ".pi/checkpoints" || normalized.startsWith(".pi/checkpoints/");
}

function appendPatchPart(parts: Buffer[], part: Buffer): void {
  if (part.length > 0) parts.push(part);
}

function buildPatchBuffer(parts: Buffer[]): Buffer {
  if (parts.length === 0) return Buffer.alloc(0);
  const separator = Buffer.from("\n\n");
  const chunks: Buffer[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) chunks.push(separator);
    chunks.push(parts[index]);
  }
  const combined = Buffer.concat(chunks);
  return combined[combined.length - 1] === 0x0a ? combined : Buffer.concat([combined, Buffer.from("\n")]);
}

function assertCheckpointPatchSize(parts: Buffer[], maxBytes: number): void {
  const size = buildPatchBuffer(parts).length;
  if (size > maxBytes) {
    throw new Error(`Checkpoint patch is ${size} bytes, exceeding maxBytes (${maxBytes}); retry with a higher maxBytes value or narrow the diff first.`);
  }
}

async function buildEmptyUntrackedPatch(root: string, filePath: string): Promise<Buffer> {
  const fileStat = await stat(path.join(root, filePath));
  if (fileStat.size > 0) {
    throw new Error(`git produced no patch output for non-empty untracked file: ${filePath}`);
  }
  const mode = fileStat.mode & 0o111 ? "100755" : "100644";
  return Buffer.from([
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode ${mode}`,
    `index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 ${mode}`,
    "--- /dev/null",
    `+++ b/${filePath}`,
    "",
  ].join("\n"));
}

async function buildUntrackedPatchParts(root: string, files: string[], signal: AbortSignal | undefined, maxBytes: number): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for (const file of files) {
    const result = await runGitBuffer(["diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", file], root, signal, maxBytes);
    if (result.truncated) {
      throw new Error(`Untracked file patch exceeded maxBytes while reading ${file}; retry with a higher maxBytes value or add the file intentionally before checkpointing.`);
    }
    if (result.exitCode > 1) {
      throw new Error(result.stderr || `git diff --no-index failed for untracked file: ${file}`);
    }

    if (result.stdout.length > 0) {
      appendPatchPart(parts, result.stdout);
    } else {
      appendPatchPart(parts, await buildEmptyUntrackedPatch(root, file));
    }
  }
  return parts;
}

export function registerCheckpointTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "checkpoint",
    label: "checkpoint",
    description: "Save the current git working tree as a restorable patch snapshot under .pi/checkpoints/<id>. It never restores automatically.",
    promptSnippet: "Save a restorable checkpoint patch",
    promptGuidelines: [
      "Use checkpoint before risky multi-file edits when the user may want a rollback point.",
      "checkpoint saves a patch and metadata plus restore instructions; it does not revert or reset files.",
    ],
    parameters: checkpointSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const root = await ensureGitRepo(ctx.cwd, signal);
      const maxBytes = clampNumber(params.maxBytes, 5_000_000, 10_000, 20_000_000);
      const includeUntracked = params.includeUntracked ?? true;
      const headExists = await hasGitHead(root, signal);
      const patchParts: Buffer[] = [];
      const trackedDiffs: string[][] = headExists
        ? [["diff", "HEAD", "--binary", "--full-index", "--no-ext-diff"]]
        : [
            ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"],
            ["diff", "--binary", "--full-index", "--no-ext-diff"],
          ];

      for (const args of trackedDiffs) {
        const diff = await runGitBuffer(args, root, signal, maxBytes);
        if (diff.exitCode !== 0) throw new Error(diff.stderr || "git diff failed");
        if (diff.truncated) {
          throw new Error(`Checkpoint patch exceeds maxBytes (${maxBytes}); no patch was saved. Retry with a higher maxBytes value or narrow the diff first.`);
        }
        appendPatchPart(patchParts, diff.stdout);
        assertCheckpointPatchSize(patchParts, maxBytes);
      }

      const status = await runGit(["status", "--short", "--untracked-files=all"], root, signal, 500_000);
      if (status.exitCode !== 0) throw new Error(status.stderr || "git status failed");
      if (status.truncated) throw new Error("git status output was truncated; checkpoint was not saved. Narrow the worktree or increase limits first.");
      const statusFiles = parseGitStatus(status.stdout).filter((item) => !isCheckpointStoragePath(item.path));
      const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], root, signal, 200_000);
      if (untracked.exitCode !== 0) throw new Error(untracked.stderr || "git ls-files failed");
      if (untracked.truncated) throw new Error("Untracked file list was truncated; checkpoint was not saved. Add or ignore some files first.");
      const untrackedList = untracked.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !isCheckpointStoragePath(file));
      if (includeUntracked && untrackedList.length > 0) {
        for (const part of await buildUntrackedPatchParts(root, untrackedList, signal, maxBytes)) {
          appendPatchPart(patchParts, part);
          assertCheckpointPatchSize(patchParts, maxBytes);
        }
      }

      if (patchParts.length === 0 && untrackedList.length === 0) {
        return { content: [{ type: "text" as const, text: "No git changes to checkpoint." }] };
      }
      if (patchParts.length === 0 && untrackedList.length > 0 && !includeUntracked) {
        return { content: [{ type: "text" as const, text: "Only untracked files were found, and includeUntracked is false; no checkpoint patch was saved." }] };
      }

      assertCheckpointPatchSize(patchParts, maxBytes);
      const createdAt = new Date().toISOString();
      const stamp = createdAt.replace(/[:.]/g, "-");
      const slug = (params.label ?? "checkpoint").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "checkpoint";
      const id = `${stamp}-${slug}`;
      const checkpointsDir = path.join(root, ".pi", "checkpoints");
      const checkpointDir = path.join(checkpointsDir, id);
      await mkdir(checkpointDir, { recursive: true });
      const patchPath = path.join(checkpointDir, "patch");
      const metaPath = path.join(checkpointDir, "meta.json");
      const relativePatchFromRoot = path.relative(root, patchPath);
      const relativeMetaFromRoot = path.relative(root, metaPath);
      const patchBuffer = buildPatchBuffer(patchParts);
      await writeFile(patchPath, patchBuffer);
      const patchStat = await runGit(["apply", "--stat", relativePatchFromRoot], root, signal, 200_000);
      if (patchStat.exitCode !== 0) throw new Error(patchStat.stderr || "git apply --stat failed for the saved checkpoint patch");
      if (patchStat.truncated) throw new Error("Checkpoint patch stat was truncated; checkpoint metadata was not saved. Narrow the diff first.");
      await writeFile(
        metaPath,
        `${JSON.stringify({
          schemaVersion: 2,
          id,
          label: params.label ?? null,
          description: params.description ?? null,
          createdAt,
          root,
          branch: await optionalGitOutput(["branch", "--show-current"], root, signal),
          head: headExists ? await optionalGitOutput(["rev-parse", "HEAD"], root, signal) : null,
          shortHead: headExists ? await optionalGitOutput(["rev-parse", "--short", "HEAD"], root, signal) : null,
          headExists,
          includeUntracked,
          files: statusFiles,
          diffStat: patchStat.stdout.trimEnd(),
          untracked: untrackedList,
          patchBytes: patchBuffer.length,
          patchPath: relativePatchFromRoot,
          metaPath: relativeMetaFromRoot,
          restore: {
            apply: `git apply ${relativePatchFromRoot}`,
            reverse: `git apply --reverse ${relativePatchFromRoot}`,
          },
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(checkpointsDir, "latest"), `${id}\n`, "utf8");

      const relPatch = path.relative(ctx.cwd, patchPath) || patchPath;
      const relMeta = path.relative(ctx.cwd, metaPath) || metaPath;
      const warnings: string[] = [];
      if (untrackedList.length > 0 && !includeUntracked) warnings.push(`Untracked files are listed in metadata but not included in the patch: ${untrackedList.join(", ")}`);
      if (!headExists) warnings.push("Repository has no HEAD yet; restore from an unborn branch can be less predictable than restoring from a recorded commit.");

      const text = [
        `Saved checkpoint: ${path.relative(ctx.cwd, checkpointDir) || checkpointDir}`,
        `Patch: ${relPatch}`,
        `Metadata: ${relMeta}`,
        `Latest pointer: ${path.relative(ctx.cwd, path.join(checkpointsDir, "latest")) || path.join(checkpointsDir, "latest")}`,
        "",
        "Restore from a clean tree with:",
        `  git apply ${relPatch}`,
        "",
        "To reverse this patch from the current tree, inspect first, then run:",
        `  git apply --reverse ${relPatch}`,
        warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text" as const, text }], details: { patchPath, metaPath, untracked: untrackedList } };
    },
  });
}
