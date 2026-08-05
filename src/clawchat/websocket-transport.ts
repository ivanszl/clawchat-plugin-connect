import { StateError, type Transport, TransportError, type TransportState } from "./protocol";

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: { error?: unknown; message?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export function createWebSocketTransport(
  WebSocketCtor: WebSocketConstructor = globalThis.WebSocket as unknown as WebSocketConstructor,
): Transport {
  let state: TransportState = "closed";
  let socket: WebSocketLike | null = null;
  return {
    get state() {
      return state;
    },
    async connect(url, handlers) {
      state = "connecting";
      const activeSocket = new WebSocketCtor(url);
      socket = activeSocket;
      const isCurrent = () => socket === activeSocket;
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        const rejectBeforeOpen = (error: Error) => {
          if (opened || settled) return;
          settled = true;
          reject(error);
        };
        activeSocket.onopen = () => {
          if (!isCurrent()) return;
          opened = true;
          settled = true;
          state = "open";
          handlers.onOpen();
          resolve();
        };
        activeSocket.onmessage = (event) => {
          if (!isCurrent()) return;
          void normalizeWebSocketData(event.data).then(handlers.onMessage).catch(handlers.onError);
        };
        activeSocket.onclose = (event) => {
          if (!isCurrent()) return;
          state = "closed";
          socket = null;
          const reason = event.reason || "closed";
          handlers.onClose(event.code, reason);
          rejectBeforeOpen(new TransportError(reason));
        };
        activeSocket.onerror = (event) => {
          if (!isCurrent()) return;
          const error =
            event.error instanceof Error
              ? event.error
              : new TransportError(event.message || "websocket transport error");
          handlers.onError(error);
          rejectBeforeOpen(error);
        };
      });
    },
    send(data) {
      if (state !== "open" || !socket) throw new StateError(`cannot send while transport=${state}`);
      socket.send(data);
    },
    close(code = 1000, reason = "client close") {
      if (state === "closed") return;
      socket?.close(code, reason);
    },
  };
}

async function normalizeWebSocketData(data: unknown): Promise<string | Buffer> {
  if (typeof data === "string" || Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  throw new TransportError(`unsupported websocket message type: ${typeof data}`);
}
