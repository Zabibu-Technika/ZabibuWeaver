// The tool registry — every capability the agent has, in one list.
import type { ToolDef, ToolSchema } from "../core/types.ts";
import { fileTools } from "./files.ts";
import { shellTool } from "./shell.ts";

export const allTools: ToolDef[] = [...fileTools, shellTool];

export function toSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function findTool(tools: ToolDef[], name: string): ToolDef | null {
  return tools.find((tool) => tool.name === name) ?? null;
}
