import { EventEmitter } from "node:events";

/** Chrome's private debugging pipe: JSON + NUL on fd 3/4, no listening port. */
export function connectPipe(child, { timeoutMs = 10_000 } = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("Browser connection closed")); }
    pending.clear();
    events.emit("close");
  };
  child.once("exit", close);
  child.once("error", close);
  child.stdio[3].on("error", close);
  child.stdio[4].on("error", close);
  child.stdio[4].on("end", close);
  child.stdio[4].on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8 * 1024 * 1024) { close(); return; }
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const data = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { close(); return; }
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message || "Browser command failed"));
        else request.resolve(message.result ?? {});
      } else if (message.method) events.emit("event", message);
    }
  });
  return {
    events,
    send(method, params = {}, sessionId = undefined) {
      if (closed) return Promise.reject(new Error("Browser connection closed"));
      if (pending.size >= 64) return Promise.reject(new Error("Browser command queue is full"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0", (error) => {
          if (!error || !pending.has(id)) return;
          clearTimeout(timer); pending.delete(id); reject(error);
        });
      });
    },
    close,
  };
}
