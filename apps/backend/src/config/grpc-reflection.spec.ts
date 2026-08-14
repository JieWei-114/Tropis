import { join } from 'path';
import * as protoLoader from '@grpc/proto-loader';
import type { Server } from '@grpc/grpc-js';
import { addGrpcReflection, grpcReflectionEnabled } from './grpc-reflection';

describe('grpcReflectionEnabled', () => {
  it('is on in development regardless of the flag', () => {
    expect(grpcReflectionEnabled('development', false)).toBe(true);
    expect(grpcReflectionEnabled('test', false)).toBe(true);
  });

  it('is off in production unless GRPC_REFLECTION=true opts in', () => {
    expect(grpcReflectionEnabled('production', false)).toBe(false);
    expect(grpcReflectionEnabled('production', true)).toBe(true);
  });
});

describe('addGrpcReflection', () => {
  it('registers the reflection service on the listener server (same package definition shape main.ts loads)', () => {
    // Load a real proto exactly like the public listener does, so the hook is
    // exercised against the same PackageDefinition shape Nest hands it.
    const pkg = protoLoader.loadSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'proto',
        'health',
        'v1',
        'health.proto',
      ),
      { keepCase: true },
    );

    const addService = jest.fn();
    addGrpcReflection(pkg, { addService } as unknown as Server);

    // ReflectionService registers both reflection protocol versions
    // (grpc.reflection.v1 and v1alpha) on the server.
    expect(addService).toHaveBeenCalledTimes(2);
    const paths = addService.mock.calls.flatMap(([serviceDef]) =>
      Object.values(serviceDef as Record<string, { path: string }>).map(
        (m) => m.path,
      ),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
        '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
      ]),
    );
  });
});
