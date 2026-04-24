import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "done";

type TodoItem = {
  id: number;
  text: string;
  status: TodoStatus;
  priority?: string;
  updatedAt: string;
};

type TodoState = {
  nextId: number;
  items: TodoItem[];
};

const todoStates = new Map<string, TodoState>();

const todoSchema = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("list"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("done"),
      Type.Literal("remove"),
      Type.Literal("clear"),
    ], { description: "Todo operation to perform (default list)" }),
  ),
  id: Type.Optional(Type.Number({ description: "Todo id for update, done, or remove" })),
  text: Type.Optional(Type.String({ description: "Todo text for add or update" })),
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")], {
      description: "Todo status for add or update",
    }),
  ),
  priority: Type.Optional(Type.String({ description: "Optional priority label, e.g. high, medium, low" })),
});

function sessionTodoState(ctx: ExtensionContext): TodoState {
  const key = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? ctx.cwd;
  let state = todoStates.get(key);
  if (!state) {
    state = { nextId: 1, items: [] };
    todoStates.set(key, state);
  }
  return state;
}

function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "No todos.";
  return items
    .map((item) => {
      const priority = item.priority ? ` priority=${item.priority}` : "";
      return `${item.id}. [${item.status}]${priority} ${item.text}`;
    })
    .join("\n");
}

export function registerTodoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "todo",
    description: "Maintain a lightweight todo list for the current session. Use for short multi-step tasks; do not replace project plans.",
    promptSnippet: "Track a lightweight session todo list",
    promptGuidelines: [
      "Use todo to track short in-session task progress when there are multiple concrete steps.",
      "Do not use todo for large implementation plans that should use the plan tools or Ralph loop.",
    ],
    parameters: todoSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = sessionTodoState(ctx);
      const action = params.action ?? "list";
      const now = new Date().toISOString();

      if (action === "add") {
        if (!params.text?.trim()) throw new Error("todo add requires text.");
        state.items.push({ id: state.nextId++, text: params.text.trim(), status: params.status ?? "pending", priority: params.priority, updatedAt: now });
      } else if (action === "update" || action === "done" || action === "remove") {
        if (params.id === undefined) throw new Error(`todo ${action} requires id.`);
        const index = state.items.findIndex((item) => item.id === params.id);
        if (index < 0) throw new Error(`Todo not found: ${params.id}`);
        if (action === "remove") {
          state.items.splice(index, 1);
        } else {
          const item = state.items[index];
          if (params.text !== undefined) item.text = params.text.trim();
          if (params.priority !== undefined) item.priority = params.priority;
          item.status = action === "done" ? "done" : params.status ?? item.status;
          item.updatedAt = now;
        }
      } else if (action === "clear") {
        state.items = [];
      }

      return {
        content: [{ type: "text" as const, text: formatTodos(state.items) }],
        details: { items: state.items },
      };
    },
  });
}
