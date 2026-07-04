import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import net from "node:net";
import readline from "node:readline";

export interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  transport?: "stdio" | "unix-websocket";
  socketPath?: string;
  startDaemon?: boolean;
  startDaemonCommand?: string;
  startDaemonArgs?: string[];
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function defaultServerRequestResponse(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [{ type: "text", text: "Background bridge declined tool call." }], success: false };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" };
    default:
      throw new Error(`Unsupported app-server request: ${method}`);
  }
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private socket: net.Socket | null = null;
  private socketBuffer = Buffer.alloc(0);
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private initialized = false;
  private options: Required<CodexAppServerClientOptions>;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      transport: options.transport ?? "stdio",
      socketPath: options.socketPath ?? "",
      startDaemon: options.startDaemon ?? false,
      startDaemonCommand: options.startDaemonCommand ?? "codex",
      startDaemonArgs: options.startDaemonArgs ?? ["app-server", "daemon", "start"],
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  async connect(): Promise<void> {
    if (this.proc) return;

    if (this.options.startDaemon) {
      const started = spawnSync(this.options.startDaemonCommand, this.options.startDaemonArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (started.status !== 0) {
        throw new Error(`Failed to start Codex app-server daemon: ${started.stderr || started.stdout || `exit ${started.status}`}`);
      }
    }

    if (this.options.transport === "unix-websocket") {
      await this.connectUnixWebSocket();
      await this.initialize();
      return;
    }

    const proc = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));
    proc.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    proc.once("error", (error) => this.failAll(asError(error)));
    proc.once("exit", (code, signal) => {
      this.failAll(new Error(`Codex app-server proxy exited (${signal ?? code ?? "unknown"})`));
      this.proc = null;
      this.initialized = false;
      this.emit("exit", { code, signal });
    });

    await this.initialize();
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.initialized = false;
      this.failAll(new Error("Codex app-server client disconnected"));
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve();
        }, 1000);
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        if (!socket.destroyed) {
          this.writeWebSocketFrame(0x8, Buffer.alloc(0));
          socket.end();
        }
      });
      return;
    }

    const proc = this.proc;
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.initialized = false;
    this.failAll(new Error("Codex app-server client disconnected"));
    if (!proc) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.stdin.end();
      proc.kill("SIGTERM");
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: {
        name: "codex_intercom_bridge",
        title: "Codex Intercom Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    if (!this.canWrite()) {
      return Promise.reject(new Error("Codex app-server client is not connected"));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.writePayload(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.canWrite()) {
      throw new Error("Codex app-server client is not connected");
    }
    const payload = params === undefined ? { method } : { method, params };
    this.writePayload(payload);
  }

  private respond(id: string | number | null | undefined, result: unknown): void {
    if (id === undefined || id === null) return;
    this.writePayload({ id, result });
  }

  private respondError(id: string | number | null | undefined, code: number, message: string): void {
    if (id === undefined || id === null) return;
    this.writePayload({ id, error: { code, message } });
  }

  private canWrite(): boolean {
    if (this.options.transport === "unix-websocket") {
      return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
    }
    return Boolean(this.proc && this.proc.stdin.writable);
  }

  private writePayload(payload: unknown): void {
    const json = JSON.stringify(payload);
    if (this.options.transport === "unix-websocket") {
      this.writeWebSocketFrame(0x1, Buffer.from(json, "utf8"));
      return;
    }
    this.proc?.stdin.write(`${json}\n`);
  }

  private connectUnixWebSocket(): Promise<void> {
    const socketPath = this.options.socketPath;
    if (!socketPath) return Promise.reject(new Error("socketPath is required for unix-websocket transport"));

    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const socket = net.createConnection(socketPath);
      this.socket = socket;
      let handshake = Buffer.alloc(0);
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanupHandshake();
          reject(error);
          return;
        }
        this.failAll(error);
        this.emit("exit", { code: null, signal: null });
      };

      const onData = (chunk: Buffer) => {
        if (settled) {
          this.handleWebSocketData(chunk);
          return;
        }

        handshake = Buffer.concat([handshake, chunk]);
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        const head = handshake.subarray(0, headerEnd).toString("utf8");
        const rest = handshake.subarray(headerEnd + 4);
        if (!/^HTTP\/1\.1 101\b/im.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
          fail(new Error(`Codex app-server WebSocket handshake failed: ${head.split("\r\n")[0] || "invalid response"}`));
          return;
        }

        settled = true;
        cleanupHandshake();
        socket.on("data", (data) => this.handleWebSocketData(data));
        socket.on("error", (error) => fail(error));
        socket.on("close", () => fail(new Error("Codex app-server WebSocket closed")));
        if (rest.length) this.handleWebSocketData(rest);
        resolve();
      };

      const cleanupHandshake = () => {
        socket.off("data", onData);
        socket.off("error", fail);
      };

      socket.once("connect", () => {
        socket.write([
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"));
      });
      socket.on("data", onData);
      socket.once("error", fail);
    });
  }

  private writeWebSocketFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;

    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
    const header = Buffer.alloc(2 + lengthBytes + 4);
    header[0] = 0x80 | opcode;
    if (length < 126) {
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    const maskOffset = 2 + lengthBytes;
    const mask = randomBytes(4);
    mask.copy(header, maskOffset);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, masked]));
  }

  private handleWebSocketData(chunk: Buffer): void {
    this.socketBuffer = Buffer.concat([this.socketBuffer, chunk]);
    while (this.socketBuffer.length >= 2) {
      const first = this.socketBuffer[0];
      const second = this.socketBuffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.socketBuffer.length < offset + 2) return;
        length = this.socketBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.socketBuffer.length < offset + 8) return;
        const bigLength = this.socketBuffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.socket?.destroy(new Error("WebSocket frame too large"));
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskOffset = masked ? offset : -1;
      if (masked) offset += 4;
      if (this.socketBuffer.length < offset + length) return;

      const mask = masked ? Buffer.from(this.socketBuffer.subarray(maskOffset, maskOffset + 4)) : null;
      const payload = Buffer.from(this.socketBuffer.subarray(offset, offset + length));
      this.socketBuffer = this.socketBuffer.subarray(offset + length);
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask![index % 4];
        }
      }

      if (opcode === 0x1) {
        this.handleLine(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.socket?.end();
      } else if (opcode === 0x9) {
        this.writeWebSocketFrame(0xA, payload);
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (error) {
      this.emit("protocolError", asError(error));
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      try {
        this.respond(message.id, defaultServerRequestResponse(message.method));
      } catch (error) {
        this.respondError(message.id, -32601, asError(error).message);
      }
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      this.emit(message.method, message.params);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
