import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_BUILTINS = new Set(["read", "bash", "edit", "write"]);
const SEARCH_BUILTINS = ["grep", "find", "ls"] as const;

function enableSearchBuiltins(pi: ExtensionAPI) {
  const activeTools = pi.getActiveTools();

  // Respect explicit no-builtin/no-tools sessions: only augment the normal default tool set.
  if (!activeTools.some((name) => DEFAULT_BUILTINS.has(name))) return;

  const availableBuiltins = new Set(
    pi
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source === "builtin")
      .map((tool) => tool.name),
  );

  const nextTools = [...activeTools];
  for (const name of SEARCH_BUILTINS) {
    if (availableBuiltins.has(name) && !nextTools.includes(name)) {
      nextTools.push(name);
    }
  }

  if (nextTools.length !== activeTools.length) {
    pi.setActiveTools(nextTools);
  }
}

export default function enableBuiltinSearchExtension(pi: ExtensionAPI) {
  pi.on("session_start", () => enableSearchBuiltins(pi));
  pi.on("resources_discover", () => enableSearchBuiltins(pi));
}
