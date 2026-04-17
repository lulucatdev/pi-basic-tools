/**
 * Shared ripgrep utilities for glob, grep, and list extensions.
 */

import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export async function exists(filepath: string): Promise<boolean> {
  try {
    await access(filepath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(command: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      const current = target === "stdout" ? stdout : stderr;
      const nextLength = current.length + text.length;
      if (nextLength > DEFAULT_OUTPUT_LIMIT_BYTES) {
        child.kill();
        finish(() =>
          reject(new Error(`${command} output exceeded ${DEFAULT_OUTPUT_LIMIT_BYTES} bytes; narrow the search or stream the output instead.`)),
        );
        return;
      }

      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      appendChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendChunk("stderr", chunk);
    });
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("close", (code: number | null) => finish(() => resolve({ stdout, stderr, exitCode: code ?? 0 })));
  });
}

function bundledRipgrepPath(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = process.platform === "win32" ? `rg-${process.platform}-${arch}.exe` : `rg-${process.platform}-${arch}`;
  // __dirname = extensions/lib/, binary is at bin/ (two levels up)
  return path.join(__dirname, "..", "..", "bin", name);
}

export async function resolveRipgrepPath(): Promise<string> {
  const home = homedir();
  const candidates = [
    bundledRipgrepPath(),
    process.env.PI_OPENCODE_RG,
    process.env.RG_PATH,
    process.env.OPENCODE_RG_PATH,
    path.join(home, ".opencode", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    path.join(home, ".local", "share", "opencode", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(locator, ["rg"], process.cwd());
  if (result.exitCode === 0) {
    const found = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) return found;
  }

  throw new Error('ripgrep (rg) was not found. Install `rg` or make sure OpenCode\'s bundled ripgrep exists.');
}

export async function assertDirectory(directory: string) {
  const info = await stat(directory).catch(() => undefined);
  if (!info) throw new Error(`No such file or directory: '${directory}'`);
  if (!info.isDirectory()) throw new Error(`Not a directory: '${directory}'`);
}

export async function safeMtime(filepath: string): Promise<number> {
  return (await stat(filepath).catch(() => undefined))?.mtime.getTime() ?? 0;
}
