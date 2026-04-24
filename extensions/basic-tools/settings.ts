import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANAGED_TOOLS = ["question", "todo", "checkpoint"] as const;

const REMOVED_TOOLS = ["git_status", "git_diff", "git_log", "git_show"] as const;

type ManagedTool = (typeof MANAGED_TOOLS)[number];
type RemovedTool = (typeof REMOVED_TOOLS)[number];

type BasicToolsSettings = {
  tools?: Partial<Record<ManagedTool, boolean>> & Partial<Record<RemovedTool, boolean>>;
};

const SETTINGS_PATH = path.join(getAgentDir(), "basic-tools-settings.json");

function isManagedTool(name: string): name is ManagedTool {
  return (MANAGED_TOOLS as readonly string[]).includes(name);
}

function isRemovedTool(name: string): name is RemovedTool {
  return (REMOVED_TOOLS as readonly string[]).includes(name);
}

function isToolEnabled(settings: BasicToolsSettings, tool: ManagedTool): boolean {
  return settings.tools?.[tool] ?? true;
}

async function loadSettings(): Promise<BasicToolsSettings> {
  try {
    const content = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(content) as BasicToolsSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSettings(settings: BasicToolsSettings): Promise<void> {
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function setToolEnabled(tool: ManagedTool, enabled: boolean): Promise<BasicToolsSettings> {
  const settings = await loadSettings();
  settings.tools = { ...(settings.tools ?? {}), [tool]: enabled };
  await saveSettings(settings);
  return settings;
}

async function setAllToolsEnabled(enabled: boolean): Promise<BasicToolsSettings> {
  const settings = await loadSettings();
  settings.tools = Object.fromEntries(MANAGED_TOOLS.map((tool) => [tool, enabled])) as Record<ManagedTool, boolean>;
  await saveSettings(settings);
  return settings;
}

export async function applyToolSettings(pi: ExtensionAPI, force = false): Promise<void> {
  const settings = await loadSettings();
  const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const activeTools = pi.getActiveTools();

  // Respect explicit no-tools sessions. The settings command uses force=true when the user opts back in.
  if (activeTools.length === 0 && !force) return;

  const nextTools = activeTools.filter((name) => {
    if (isRemovedTool(name)) return false;
    return !isManagedTool(name) || isToolEnabled(settings, name);
  });

  for (const tool of MANAGED_TOOLS) {
    if (isToolEnabled(settings, tool) && availableTools.has(tool) && !nextTools.includes(tool)) {
      nextTools.push(tool);
    }
  }

  if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
    pi.setActiveTools(nextTools);
  }
}

function formatSettings(settings: BasicToolsSettings): string {
  return MANAGED_TOOLS.map((tool) => `${isToolEnabled(settings, tool) ? "on " : "off"}  ${tool}`).join("\n");
}

async function runBasicToolsSettingsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 0) {
    const [action, rawTool] = parts;
    if (action === "list" || action === "show") {
      const settings = await loadSettings();
      pi.sendMessage({ customType: "basic-tools-settings", content: formatSettings(settings), display: true });
      return;
    }

    if ((action === "enable" || action === "disable") && rawTool) {
      const enabled = action === "enable";
      const settings = rawTool === "all" ? await setAllToolsEnabled(enabled) : isManagedTool(rawTool) ? await setToolEnabled(rawTool, enabled) : undefined;
      if (!settings) {
        ctx.ui.notify(`Unknown basic tool: ${rawTool}`, "error");
        return;
      }
      await applyToolSettings(pi, true);
      ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} ${rawTool}`, "info");
      return;
    }

    ctx.ui.notify("Usage: /basic-tools-settings [list|enable <tool|all>|disable <tool|all>]", "warning");
    return;
  }

  while (true) {
    const settings = await loadSettings();
    const options = [
      ...MANAGED_TOOLS.map((tool) => `${isToolEnabled(settings, tool) ? "[on] " : "[off]"} ${tool}`),
      "Enable all",
      "Disable all",
      "Done",
    ];
    const choice = await ctx.ui.select("Toggle pi-basic-tools", options);
    if (!choice || choice === "Done") return;

    if (choice === "Enable all" || choice === "Disable all") {
      await setAllToolsEnabled(choice === "Enable all");
    } else {
      const tool = MANAGED_TOOLS.find((name) => choice.endsWith(name));
      if (tool) {
        await setToolEnabled(tool, !isToolEnabled(settings, tool));
      }
    }

    await applyToolSettings(pi, true);
  }
}

export function registerBasicToolsSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("basic-tools-settings", {
    description: "Toggle pi-basic-tools helper tools",
    getArgumentCompletions: (prefix) => {
      const input = prefix.trimStart();
      const [action] = input.split(/\s+/, 1);
      if (!input.includes(" ")) return ["list", "enable", "disable"].map((value) => ({ value }));
      if (action === "enable" || action === "disable") return ["all", ...MANAGED_TOOLS].map((tool) => ({ value: `${action} ${tool}` }));
      return [];
    },
    handler: async (args, ctx) => runBasicToolsSettingsCommand(pi, args, ctx),
  });
}
