import * as http from 'http';
import * as http2 from 'http2';
import * as net from 'net';
import type { AddressInfo } from 'net';
import type { RpcRequestHandler } from './rpc-cors';

/** First bytes of the HTTP/2 connection preface (`PRI * HTTP/2.0`). */
const H2_PREFACE_START = 'PRI';
/** A connection that sends nothing for this long is dropped before routing. */
const SNIFF_TIMEOUT_MS = 10_000;

/**
 * One TCP port that speaks both cleartext HTTP/2 and HTTP/1.1.
 *
 * gRPC needs HTTP/2 (trailers, bidi streaming for reflection), while browsers
 * and curl use the Connect and gRPC-Web protocols over HTTP/1.1. Node's
 * `http2.createServer` honours `allowHTTP1` only with TLS, so each connection
 * is routed by its first bytes instead: the HTTP/2 preface goes to the h2c
 * server, anything else to the HTTP/1.1 server. Both run the same handler.
 */
export class RpcListener {
  private readonly h1: http.Server;
  private readonly h2: http2.Http2Server;
  private readonly tcp: net.Server;
  private readonly sessions = new Set<http2.ServerHttp2Session>();
  /** HTTP/1.1 connections and how many requests each has in flight. */
  private readonly h1Sockets = new Map<net.Socket, number>();
  /** Connections still waiting for their first bytes. */
  private readonly unrouted = new Set<net.Socket>();
  private closing = false;

  constructor(handler: RpcRequestHandler) {
    this.h1 = http.createServer((req, res) => {
      const socket = req.socket;
      if (this.h1Sockets.has(socket)) {
        this.h1Sockets.set(socket, (this.h1Sockets.get(socket) ?? 0) + 1);
      }
      if (this.closing) res.setHeader('Connection', 'close');
      res.once('close', () => {
        if (!this.h1Sockets.has(socket)) return;
        const left = (this.h1Sockets.get(socket) ?? 1) - 1;
        this.h1Sockets.set(socket, left);
        if (this.closing && left === 0) socket.end();
      });
      handler(req, res);
    });
    this.h2 = http2.createServer(handler);
    this.h2.on('session', (session) => {
      this.sessions.add(session);
      session.once('close', () => this.sessions.delete(session));
    });
    this.tcp = net.createServer((socket) => this.route(socket));
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.tcp.once('error', reject);
      this.tcp.listen(port, host, () => {
        this.tcp.off('error', reject);
        resolve((this.tcp.address() as AddressInfo).port);
      });
    });
  }

  /**
   * Stops accepting connections and lets in-flight calls finish: HTTP/2
   * sessions get GOAWAY, idle HTTP/1.1 keep-alive connections are ended now
   * and busy ones after their current response.
   */
  close(): Promise<void> {
    if (!this.tcp.listening) return Promise.resolve();
    this.closing = true;
    const closed = new Promise<void>((resolve) =>
      this.tcp.close(() => resolve()),
    );
    for (const socket of this.unrouted) socket.destroy();
    for (const session of this.sessions) session.close();
    for (const [socket, inFlight] of this.h1Sockets) {
      if (inFlight === 0) socket.end();
    }
    this.h1.close();
    this.h2.close();
    return closed;
  }

  private route(socket: net.Socket): void {
    // Until a server owns the socket, errors must not crash the process.
    const onError = () => socket.destroy();
    socket.on('error', onError);
    this.unrouted.add(socket);
    socket.once('close', () => this.unrouted.delete(socket));
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());

    const sniff = () => {
      const chunk = socket.read() as Buffer | null;
      if (chunk === null) {
        socket.once('readable', sniff);
        return;
      }
      socket.unshift(chunk);
      if (chunk.length < H2_PREFACE_START.length) {
        socket.once('readable', sniff);
        return;
      }
      socket.setTimeout(0);
      socket.off('error', onError);
      this.unrouted.delete(socket);
      const isH2 =
        chunk.toString('latin1', 0, H2_PREFACE_START.length) ===
        H2_PREFACE_START;
      if (isH2) {
        this.h2.emit('connection', socket);
        return;
      }
      this.h1Sockets.set(socket, 0);
      socket.once('close', () => this.h1Sockets.delete(socket));
      this.h1.emit('connection', socket);
    };
    socket.once('readable', sniff);
  }
}
