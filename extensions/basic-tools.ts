import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCheckpointTool } from "./basic-tools/checkpoint.ts";
import { registerQuestionTool } from "./basic-tools/question.ts";
import { applyToolSettings, registerBasicToolsSettingsCommand } from "./basic-tools/settings.ts";
import { registerTodoTool } from "./basic-tools/todo.ts";

export default function basicToolsExtension(pi: ExtensionAPI) {
  registerQuestionTool(pi);
  registerTodoTool(pi);
  registerCheckpointTool(pi);

  pi.on("session_start", () => applyToolSettings(pi));
  pi.on("resources_discover", () => applyToolSettings(pi));

  registerBasicToolsSettingsCommand(pi);
}
