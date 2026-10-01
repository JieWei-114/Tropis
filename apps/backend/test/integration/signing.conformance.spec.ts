import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { NativeSigningAdapter } from '../../src/infrastructure/signing/adapters/native/native-signing.adapter';
import {
  describeSigningPort,
  SIGNING_VECTOR,
} from '../../src/infrastructure/signing/__tests__/signing.conformance';
import { freePort, waitUntil } from './containers';

jest.setTimeout(120_000);

/**
 * Runs the conformance suite against the real native signing service
 * (services/rust/signing). Needs a built binary: `cargo build -p signing`.
 */
const BINARY = resolve(__dirname, '../../../../target/debug/signing');
const describeWithBinary = existsSync(BINARY) ? describe : describe.skip;
if (!existsSync(BINARY)) {
  process.emitWarning(
    `[integration] ${BINARY} not built — skipping native signing conformance. Run \`cargo build -p signing\`.`,
  );
}

describeWithBinary('Signing conformance (native service)', () => {
  let child: ChildProcess;
  let adapter: NativeSigningAdapter;

  beforeAll(async () => {
    const port = await freePort();
    child = spawn(BINARY, [], {
      env: {
        ...process.env,
        GRPC_PORT: String(port),
        API_KEYS: JSON.stringify({
          [SIGNING_VECTOR.keyId]: {
            secret: SIGNING_VECTOR.secret,
            tenantId: 'conformance',
          },
        }),
        RUST_LOG: 'warn',
      },
      stdio: 'ignore',
    });
    adapter = new NativeSigningAdapter(`http://127.0.0.1:${port}`);
    await waitUntil(
      'signing service',
      async () => (await adapter.health()).status === 'up',
      30_000,
    );
  });

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  describeSigningPort('native', { make: () => adapter });
});
