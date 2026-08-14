/**
 * Realtime — thin wrapper over the Socket.io gateway at /ws with
 * auto-reconnect and race protection (a second connect while a socket is
 * connected or mid-handshake reuses the existing one).
 */

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export type WsEventName = 'user.created' | 'user.updated' | 'notification';

export interface WsEvent {
  name: WsEventName;
  data: Record<string, unknown>;
}

const WATCHED: WsEventName[] = ['user.created', 'user.updated', 'notification'];

export interface RealtimeOptions {
  /** Socket.io gateway origin, e.g. http://localhost:3100 (namespace /ws is appended). */
  url: string;
  /** Bearer token for the handshake; connection is skipped when null. */
  token: string | null;
}

/**
 * Connect to the Socket.io gateway at /ws.
 * Returns a cleanup function — call it on unmount or logout.
 */
export function connectRealtime(
  options: RealtimeOptions,
  onEvent: (e: WsEvent) => void,
): () => void {
  const { url, token } = options;
  if (!token) return () => {};

  // Reuse the existing socket if it is already connected or mid-handshake —
  // creating a second one would leak connections and duplicate events.
  if (socket && (socket.connected || socket.active)) {
    const existing = socket;
    return () => {
      existing.disconnect();
      if (socket === existing) socket = null;
    };
  }

  socket = io(`${url}/ws`, {
    auth: { token },
    transports: ['websocket'],
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    // Measure round-trip latency on connect
    socket!.emit('ping');
  });

  socket.on('pong', ({ ts }: { ts: number }) => {
    console.debug(`[WS] latency ${Date.now() - ts}ms`);
  });

  for (const ev of WATCHED) {
    socket.on(ev, (data: Record<string, unknown>) => onEvent({ name: ev, data }));
  }

  const created = socket;
  return () => {
    created.disconnect();
    if (socket === created) socket = null;
  };
}

export function isRealtimeConnected(): boolean {
  return socket?.connected ?? false;
}
