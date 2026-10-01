import {
  defineKey,
  escapeKeyId,
  InvalidKeyError,
  InvalidTenantIdError,
  resolveKeyspaceSettings,
  toTenantId,
  type CacheKey,
  type KvKey,
  type TenantId,
} from '..';

describe('keyspace', () => {
  const acme = toTenantId('acme');
  const profile = defineKey({
    capability: 'cache',
    module: 'user',
    name: 'profile',
    version: 'v1',
  }).withKeyspace({ app: 'tropis', env: 'prod' });

  it('builds tenant and global keys in the standard format', () => {
    expect(profile.forTenant(acme, '6650c1')).toBe(
      'tropis:prod:t.acme:cache:user:profile:v1:6650c1',
    );
    expect(profile.global()).toBe('tropis:prod:global:cache:user:profile:v1');
    expect(profile.forTenant(acme, 'a', 2)).toBe(
      'tropis:prod:t.acme:cache:user:profile:v1:a:2',
    );
  });

  it('escapes ids so they cannot inject segments or globs', () => {
    const key = profile.forTenant(acme, 'x:global:cache', '*');
    expect(key.split(':')).toHaveLength(9);
    expect(key).toContain('x%3Aglobal%3Acache');
    expect(key).toContain('%2A');
    expect(escapeKeyId('Mixed-Case_1')).toBe('Mixed-Case_1');
    expect(() => escapeKeyId('')).toThrow(InvalidKeyError);
  });

  it('keeps tenants distinct from the global scope', () => {
    const tenantNamedGlobal = toTenantId('global');
    expect(profile.forTenant(tenantNamedGlobal)).not.toBe(profile.global());
  });

  it('reads app and env from the environment at build time', () => {
    expect(
      resolveKeyspaceSettings({ KEYSPACE_APP: 'a', KEYSPACE_ENV: 'b' }),
    ).toEqual({ app: 'a', env: 'b' });
    expect(resolveKeyspaceSettings({ NODE_ENV: 'test' })).toEqual({
      app: 'tropis',
      env: 'test',
    });

    const previous = { ...process.env };
    try {
      process.env.KEYSPACE_APP = 'other';
      process.env.KEYSPACE_ENV = 'staging';
      const key = defineKey({
        capability: 'kv',
        module: 'user',
        name: 'profile',
        version: 'v2',
      }).global('1');
      expect(key).toBe('other:staging:global:kv:user:profile:v2:1');
    } finally {
      process.env = previous;
    }
  });

  it.each([
    [{ module: 'User', name: 'profile', version: 'v1' }],
    [{ module: 'user', name: 'Profile', version: 'v1' }],
    [{ module: 'user', name: 'user_profile', version: 'v1' }],
    [{ module: 'user', name: 'user:profile', version: 'v1' }],
    [{ module: 'user', name: 'usr-profile', version: 'v1' }],
    [{ module: 'user', name: 'profile', version: '1' }],
    [{ module: 'user', name: 'profile', version: 'v0' }],
  ])('rejects invalid spec %j', (spec) => {
    expect(() => defineKey({ capability: 'cache', ...spec } as never)).toThrow(
      InvalidKeyError,
    );
  });

  it('rejects an unknown capability and invalid keyspace settings', () => {
    expect(() =>
      defineKey({
        capability: 'queue' as never,
        module: 'user',
        name: 'profile',
        version: 'v1',
      }),
    ).toThrow(InvalidKeyError);
    expect(() => profile.withKeyspace({ app: 'Tropis', env: 'prod' })).toThrow(
      InvalidKeyError,
    );
  });

  it('rejects an unbranded tenant id at runtime', () => {
    expect(() => toTenantId('a:b')).toThrow(InvalidTenantIdError);
    expect(() => profile.forTenant('bad tenant' as TenantId)).toThrow(
      InvalidTenantIdError,
    );
  });

  describe('type safety', () => {
    it('does not let raw strings or other capabilities stand in for a key', () => {
      const kvProfile = defineKey({
        capability: 'kv',
        module: 'user',
        name: 'profile',
        version: 'v1',
      });

      // @ts-expect-error a raw string is not a CacheKey
      const fromString: CacheKey = 'tropis:prod:global:cache:user:profile:v1';
      // @ts-expect-error a KvKey is not a CacheKey
      const fromKv: CacheKey = kvProfile.global();
      // @ts-expect-error a CacheKey is not a KvKey
      const fromCache: KvKey = profile.global();
      // @ts-expect-error a raw string is not a TenantId
      profile.forTenant('acme');
      // @ts-expect-error the spec capability decides the key type
      const wrongSpec: KvKey = defineKey({
        capability: 'lock',
        module: 'user',
        name: 'profile',
        version: 'v1',
      }).global();

      const ok: CacheKey = profile.forTenant(acme);
      expect([fromString, fromKv, fromCache, wrongSpec, ok]).toHaveLength(5);
    });
  });
});
