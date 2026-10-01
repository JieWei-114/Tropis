import { grpcReflectionEnabled } from './grpc-reflection';

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
