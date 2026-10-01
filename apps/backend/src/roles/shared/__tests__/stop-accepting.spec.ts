import { createServer, type Server } from 'http';
import { connect } from 'net';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { stopAccepting, trackUpgrades } from '../http.surface';

function upgrade(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      setTimeout(resolve, 50);
    });
    socket.on('error', reject);
  });
}

describe('stopAccepting', () => {
  let server: Server;
  const held: Duplex[] = [];

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    trackUpgrades(server);
    // Stands in for the WebSocket server: takes the socket and keeps it open.
    server.on('upgrade', (_req, socket: Duplex) => {
      held.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  });

  it('ends upgraded sockets so the server closes without waiting for them', async () => {
    await upgrade((server.address() as AddressInfo).port);
    expect(held).toHaveLength(1);
    const started = Date.now();
    await stopAccepting(server);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(held[0].destroyed).toBe(true);
  });
});
