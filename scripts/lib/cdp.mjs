import { CdpTimeoutError } from "./archive-return.mjs";

/** Shared transport; each harness keeps its own wait and diagnostic policy. */
export class Cdp {
  constructor(socket, { timeoutMs = 90000, recordConsole = true, evaluateFallback = null } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.evaluateFallback = evaluateFallback;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (recordConsole && message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? []).map(arg => arg.value ?? arg.description ?? arg.type).join(" ");
        this.logs.push(`${message.params.type}: ${text}`.slice(0, 300));
      }
      if (recordConsole && message.method === "Runtime.exceptionThrown")
        this.logs.push(`exception: ${message.params.exceptionDetails?.exception?.description?.slice(0, 300)}`);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      this.pending.set(id, pending);
      pending.timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new CdpTimeoutError(method));
        }
      }, timeoutMs);
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, awaitPromise = true, timeoutMs = this.timeoutMs) {
    const result = await this.send("Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? this.evaluateFallback ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}
