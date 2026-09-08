// Thin adapter over @tropis/sdk realtime — keeps the existing connectWs()
// surface while the socket.io logic (auto-reconnect, race protection)
// lives in the SDK.
import {
  connectRealtime,
  isRealtimeConnected,
  getToken,
  type WsEvent,
} from '@tropis/sdk';
import { env } from './env';

export type { WsEvent } from '@tropis/sdk';

/**
 * Connect to the Socket.io gateway at /ws.
 * Returns a cleanup function — call it on unmount or logout.
 */
export function connectWs(onEvent: (e: WsEvent) => void): () => void {
  return connectRealtime({ url: env.VITE_WS_URL, token: getToken() }, onEvent);
}

export function isConnected(): boolean {
  return isRealtimeConnected();
}
