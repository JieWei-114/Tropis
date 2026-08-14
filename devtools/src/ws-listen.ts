/**
 * WebSocket firehose — connects to the Socket.io gateway (namespace /ws,
 * `auth.token` handshake, same contract as packages/sdk/src/realtime) and
 * prints EVERY event it receives with a timestamp. Ctrl-C to exit.
 *
 * Auth: pass TOKEN=<jwt> to use an existing token; otherwise it logs in via
 * gRPC as admin@example.com / Password123! (the `make seed` admin), same as
 * the seeder. Override with WS_EMAIL / WS_PASSWORD.
 *
 * Run: `make ws-listen [TOKEN=...]`  (→ pnpm --filter @tropis/devtools ws-listen)
 */
import { io } from 'socket.io-client';
import { checkHealth, loginForToken } from './lib/grpc';

const WS_URL = process.env.WS_URL ?? 'http://localhost:3100';
const EMAIL = process.env.WS_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.WS_PASSWORD ?? 'Password123!';

function ts(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  await checkHealth();

  let token = process.env.TOKEN;
  if (!token) {
    console.log(`No TOKEN given — logging in as ${EMAIL} over gRPC…`);
    try {
      token = await loginForToken(EMAIL, PASSWORD);
    } catch (err) {
      console.error(
        `✗ Login failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` +
          `\n  Seed the admin user first (make seed) or pass TOKEN=<jwt>.`,
      );
      process.exit(1);
    }
  }

  const socket = io(`${WS_URL}/ws`, {
    auth: { token },
    transports: ['websocket'],
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    console.log(`[${ts()}] ✓ connected to ${WS_URL}/ws (id=${socket.id}) — listening for all events…`);
  });
  socket.on('connect_error', (err) => {
    console.error(`[${ts()}] ✗ connect_error: ${err.message}`);
  });
  socket.on('disconnect', (reason) => {
    console.log(`[${ts()}] disconnected: ${reason}`);
  });
  socket.onAny((event, ...args) => {
    console.log(`[${ts()}] ${event} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  });

  process.on('SIGINT', () => {
    console.log('\nbye');
    socket.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('ws-listen failed:', err);
  process.exit(1);
});
