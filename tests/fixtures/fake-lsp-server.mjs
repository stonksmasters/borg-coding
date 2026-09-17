let buffer = Buffer.alloc(0);
let rootUri = "";
let openedUri = "";

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function range(line = 0, start = 0, end = 6) {
  return { start: { line, character: start }, end: { line, character: end } };
}

function handle(message) {
  if (message.method === "initialize") {
    rootUri = message.params.rootUri;
    response(message.id, {
      capabilities: {
        workspaceSymbolProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        hoverProvider: true,
        callHierarchyProvider: true,
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    response(message.id, null);
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.method === "textDocument/didOpen") {
    openedUri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: openedUri,
        diagnostics: [{ range: range(1, 4, 9), severity: 2, code: 7001, message: "Fake warning" }],
      },
    });
    return;
  }
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "workspace/symbol") {
    response(message.id, [
      { name: "inside_symbol", kind: 12, containerName: "fixture", location: { uri: `${rootUri}/sample.py`, range: range() } },
      { name: "outside_symbol", kind: 12, location: { uri: "file:///definitely-outside.py", range: range() } },
    ]);
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    response(message.id, [{
      name: "Example",
      kind: 5,
      range: range(0, 0, 12),
      selectionRange: range(0, 6, 13),
      children: [{ name: "method", kind: 6, range: range(1, 4, 10), selectionRange: range(1, 4, 10) }],
    }]);
    return;
  }
  if (message.method === "textDocument/definition") {
    response(message.id, [
      { uri: openedUri, range: range(0, 6, 13) },
      { uri: "file:///definitely-outside.py", range: range() },
    ]);
    return;
  }
  if (message.method === "textDocument/references") {
    response(message.id, [{ uri: openedUri, range: range(1, 4, 10) }]);
    return;
  }
  if (message.method === "textDocument/implementation") {
    response(message.id, [{ targetUri: openedUri, targetSelectionRange: range(1, 4, 10) }]);
    return;
  }
  if (message.method === "textDocument/hover") {
    response(message.id, { contents: { kind: "markdown", value: "**Example** fake hover" }, range: range(0, 6, 13) });
    return;
  }
  if (message.method === "textDocument/prepareCallHierarchy") {
    response(message.id, [{
      name: "Example",
      kind: 12,
      detail: "fixture",
      uri: openedUri,
      range: range(0, 0, 13),
      selectionRange: range(0, 6, 13),
    }]);
    return;
  }
  if (message.method === "callHierarchy/incomingCalls") {
    response(message.id, [{
      from: {
        name: "caller",
        kind: 12,
        uri: openedUri,
        range: range(1, 0, 12),
        selectionRange: range(1, 4, 10),
      },
      fromRanges: [range(1, 4, 10)],
    }]);
    return;
  }
  if (message.method === "callHierarchy/outgoingCalls") {
    response(message.id, [{
      to: {
        name: "callee",
        kind: 12,
        uri: openedUri,
        range: range(1, 0, 12),
        selectionRange: range(1, 4, 10),
      },
      fromRanges: [range(0, 6, 13)],
    }]);
    return;
  }
  response(message.id, null);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
