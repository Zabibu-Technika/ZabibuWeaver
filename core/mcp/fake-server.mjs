import * as readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "write_note",
            description: "Write a note",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" }, text: { type: "string" } },
              required: ["path", "text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${args.text}` }] } });
      return;
    }
    if (name === "write_note") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `wrote ${args.path}` }] } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "unknown tool" }] } });
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
});

lines.on("close", () => process.exit(0));
