// A bounded, read-only subagent tool.
//
// The child gets its own context and a small read/search/LSP toolset. It can investigate a
// question without polluting the parent's context or gaining the ability to write. That is
// the useful, safe version of a subagent: delegation for research, not a second pair of
// hands on the filesystem.
import { runSubagent } from "../core/agent.ts";
import type { Provider, ToolDef, ToolOutcome } from "../core/types.ts";
import type { WeaverConfig } from "../config.ts";

export interface SubagentToolDeps {
  provider: Provider;
  config: WeaverConfig;
  tools: ToolDef[];
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDef {
  return {
    name: "subagent",
    description:
      "Delegate a read-only research question to a fresh, bounded agent context. Use it to inspect a large area without filling the main context. The subagent cannot edit files.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The research question or task for the subagent." },
        role: {
          type: "string",
          enum: ["research", "review"],
          description: "Optional framing: research or review.",
        },
      },
      required: ["prompt"],
    },
    mutating: false,
    capability: "read",
    ingest: "local",
    async run(input, ctx): Promise<ToolOutcome> {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (prompt.length === 0) return { ok: false, output: "subagent: prompt is required" };
      const role = input.role === "review" ? "review" : "research";

      const result = await runSubagent(
        {
          config: { ...deps.config, workspace: ctx.workspace },
          provider: deps.provider,
          tools: deps.tools,
          confirm: async () => "no",
          emit: () => {},
        },
        prompt,
        { role, maxSteps: 6 },
      );

      if (result.text.length === 0) {
        return {
          ok: false,
          output: `Subagent (${role}) returned no text after ${result.steps} message(s) and ${result.toolCalls} tool call(s).`,
        };
      }

      return {
        ok: true,
        output: `Subagent (${role}) — ${result.toolCalls} tool call(s), ${result.steps} message(s)\n\n${result.text}`,
      };
    },
  };
}
