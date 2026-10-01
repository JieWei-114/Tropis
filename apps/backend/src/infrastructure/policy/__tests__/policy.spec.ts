import { OpaPolicyAdapter } from '../adapters/opa/opa-policy.adapter';

describe('OpaPolicyAdapter', () => {
  const input = { roles: ['admin'], resource: 'user', action: 'read' };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('allows when OPA answers result=true', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ result: true }), { status: 200 }),
    );
    await expect(new OpaPolicyAdapter('http://opa').allow(input)).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://opa/v1/data/authz/allow',
      expect.objectContaining({ body: JSON.stringify({ input }) }),
    );
  });

  it('denies on anything but result=true', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(new OpaPolicyAdapter('http://opa').allow(input)).resolves.toBe(
      false,
    );
  });

  it('answers SERVICE_UNAVAILABLE, not a denial, when OPA errors', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(
      new OpaPolicyAdapter('http://opa').allow(input),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers SERVICE_UNAVAILABLE when OPA is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      new OpaPolicyAdapter('http://opa').allow(input),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('stops calling OPA once the circuit opens, still unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new OpaPolicyAdapter('http://opa');
    for (let i = 0; i < 5; i++) await adapter.allow(input).catch(() => {});
    fetchMock.mockClear();

    await expect(adapter.allow(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends OPA_TOKEN as a bearer token when set', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ result: true }), { status: 200 }),
    );
    await new OpaPolicyAdapter('http://opa', 's3cret').allow(input);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer s3cret',
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await new OpaPolicyAdapter('http://opa', 's3cret').health();
    const probe = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(probe.headers).get('authorization')).toBe(
      'Bearer s3cret',
    );
  });

  it('sends no authorization header without a token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ result: true }), { status: 200 }),
    );
    await new OpaPolicyAdapter('http://opa').allow(input);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('reports health from the /health endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(new OpaPolicyAdapter('http://opa').health()).resolves.toEqual({
      status: 'up',
      adapter: 'opa',
    });
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      new OpaPolicyAdapter('http://opa').health(),
    ).resolves.toMatchObject({ status: 'down' });
  });
});
