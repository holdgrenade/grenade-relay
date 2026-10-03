/**
 * A WebSocket as the hub's `Pipe`. A peer that stops reading is dropped once `MAX_BUFFERED_BYTES` wait for it,
 * so one slow or stalled socket cannot fill the relay's memory. Dropping it fires its close handler like any
 * other lost connection.
 */
import type { Pipe } from "./hub.js";

export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** What `pipeOf` needs from a `ws` WebSocket. Tests pass a fake. */
export interface PipeSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly CONNECTING: number;
  /** Bytes queued for this socket that the peer has not taken yet. */
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export function pipeOf(ws: PipeSocket, maxBuffered: number = MAX_BUFFERED_BYTES): Pipe {
  return {
    send: (text) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) return ws.terminate();
      ws.send(text);
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    },
  };
}
