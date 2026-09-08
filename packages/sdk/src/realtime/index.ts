/**
 * Realtime — thin wrapper over the Socket.io gateway at /ws with
 * auto-reconnect and race protection (a second connect while a socket is
 * connected or mid-handshake reuses the existing one).
 */

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/**
 * Every active subscriber. The socket is a singleton shared by all callers, so
 * the set is what makes each caller's handler reachable when it joins an
 * already-open socket, and what tells a cleanup whether anyone is still
 * listening before it disconnects.
 */
const listeners = new Set<(e: WsEvent) => void>();

function fanOut(e: WsEvent): void {
  for (const listener of listeners) listener(e);
}

export type WsEventName =
  | 'user.created'
  | 'user.updated'
  | 'notification'
  | 'analytics.event'
  | 'tracking.event';

export interface WsEvent {
  name: WsEventName;
  data: Record<string, unknown>;
}

const WATCHED: WsEventName[] = [
  'user.created',
  'user.updated',
  'notification',
  'analytics.event',
  'tracking.event',
];

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

  listeners.add(onEvent);

  // One socket for the whole app; a second connect only registers a listener.
  if (!socket || !(socket.connected || socket.active)) {
    // A socket that exhausted its reconnection attempts is inactive but still
    // holds its handlers — detach it explicitly instead of orphaning it.
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
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
      // Round-trip probe; the gateway answers with 'pong' from its
      // @SubscribeMessage('ping') handler, confirming the namespace is live.
      socket?.emit('ping');
    });

    for (const ev of WATCHED) {
      socket.on(ev, (data: Record<string, unknown>) =>
        fanOut({ name: ev, data }),
      );
    }
  }

  return () => {
    listeners.delete(onEvent);
    // Close only once nobody is listening any more.
    if (listeners.size === 0 && socket) {
      socket.disconnect();
      socket = null;
    }
  };
}

export function isRealtimeConnected(): boolean {
  return socket?.connected ?? false;
}
