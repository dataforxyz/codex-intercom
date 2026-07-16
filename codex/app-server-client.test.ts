import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerClient, defaultServerRequestResponse, WebSocketFrameDecoder } from "./app-server-client.ts";

function frame(opcode: number, payload: string, fin = true): Buffer {
  const data = Buffer.from(payload);
  assert.ok(data.length < 126);
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]),
    data,
  ]);
}

test("defaultServerRequestResponse denies command approvals", () => {
  assert.deepEqual(defaultServerRequestResponse("item/commandExecution/requestApproval"), { decision: "decline" });
  assert.deepEqual(defaultServerRequestResponse("execCommandApproval"), { decision: "denied" });
});

test("defaultServerRequestResponse declines interactive requests", () => {
  assert.deepEqual(defaultServerRequestResponse("item/tool/requestUserInput"), { answers: {} });
  assert.deepEqual(defaultServerRequestResponse("mcpServer/elicitation/request"), { action: "decline", content: null, _meta: null });
});

test("defaultServerRequestResponse rejects unknown requests", () => {
  assert.throws(() => defaultServerRequestResponse("unknown/request"), /Unsupported app-server request/);
});

test("app-server error notifications do not trigger Node's unhandled error event", () => {
  const client = new CodexAppServerClient();
  let notification: unknown;
  let serverError: unknown;
  client.on("notification", (message) => { notification = message; });
  client.on("serverError", (params) => { serverError = params; });
  const params = {
    error: {
      message: "Reconnecting... 1/5",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: "stream disconnected before completion: stream closed before response.completed",
    },
    willRetry: true,
    threadId: "thread-1",
    turnId: "turn-1",
  };
  assert.doesNotThrow(() => (client as any).handleLine(JSON.stringify({ method: "error", params })));
  assert.deepEqual(notification, { method: "error", params });
  assert.deepEqual(serverError, params);
});

test("WebSocketFrameDecoder reassembles fragmented text frames", () => {
  const decoder = new WebSocketFrameDecoder();
  assert.deepEqual(decoder.push(frame(0x1, "hel", false)), []);
  assert.deepEqual(decoder.push(frame(0x0, "lo")), [{ opcode: 0x1, payload: Buffer.from("hello") }]);
});

test("WebSocketFrameDecoder buffers partial frames", () => {
  const decoder = new WebSocketFrameDecoder();
  const whole = frame(0x1, "{\"ok\":true}");
  assert.deepEqual(decoder.push(whole.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(whole.subarray(3)), [{ opcode: 0x1, payload: Buffer.from("{\"ok\":true}") }]);
});

test("WebSocketFrameDecoder rejects invalid continuations", () => {
  const decoder = new WebSocketFrameDecoder();
  assert.throws(() => decoder.push(frame(0x0, "dangling")), /Unexpected WebSocket continuation frame/);
});
