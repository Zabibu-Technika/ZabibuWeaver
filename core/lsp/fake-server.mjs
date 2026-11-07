let buffer = Buffer.alloc(0);

function send(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
        },
      },
    });
    return;
  }
  if (method === "initialized") return;
  if (method === "textDocument/didOpen") {
    const uri = params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            severity: 2,
            source: "fake-lsp",
            message: "fake warning",
          },
        ],
      },
    });
    return;
  }
  if (method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      },
    });
    return;
  }
  if (method === "textDocument/references") {
    const uri = params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      id,
      result: [
        { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        { uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } } },
      ],
    });
    return;
  }
  if (method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id,
      result: { contents: { kind: "markdown", value: "**fake hover**" } },
    });
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // Ignore malformed frames.
    }
  }
});
