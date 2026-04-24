import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const questionSchema = Type.Object({
  question: Type.String({ description: "Question to ask the user" }),
  context: Type.Optional(Type.String({ description: "Short context explaining why the answer is needed" })),
  options: Type.Optional(Type.Array(Type.String({ description: "Suggested answer option" }))),
  allowFreeText: Type.Optional(Type.Boolean({ description: "Allow the user to enter a custom answer (default true)" })),
});

export function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "question",
    label: "question",
    description: "Ask the user a focused question during execution. Supports suggested options and free-text answers.",
    promptSnippet: "Ask the user a focused question with optional choices",
    promptGuidelines: [
      "Use question when a user decision is required before proceeding.",
      "Prefer concise questions with a small set of meaningful options.",
    ],
    parameters: questionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const allowFreeText = params.allowFreeText ?? true;
      const options = (params.options ?? []).filter((option) => option.trim().length > 0);
      const title = params.context ? `${params.question}\n\n${params.context}` : params.question;
      let answer: string | undefined;

      if (options.length > 0) {
        const customOption = "Other / custom answer";
        const choice = await ctx.ui.select(title, allowFreeText ? [...options, customOption] : options);
        if (!choice) return { content: [{ type: "text" as const, text: "User cancelled the question." }] };
        answer = choice === customOption ? await ctx.ui.input(params.question, "Type your answer") : choice;
      } else {
        answer = await ctx.ui.input(title, "Type your answer");
      }

      if (answer === undefined) {
        return { content: [{ type: "text" as const, text: "User cancelled the question." }] };
      }

      return {
        content: [{ type: "text" as const, text: `User answered: ${answer}` }],
        details: { answer },
      };
    },
  });
}
