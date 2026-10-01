import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { validatedConfigModule } from '../validated-config';

describe('validatedConfigModule', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  // Reproduces the gap: config was validated before the Vault adapter merged
  // its KV secrets, so a schema-declared key held only in Vault failed
  // validation (or lost to its default) and never reached ConfigService.
  it('validates after the Vault secrets are merged, so Vault can supply a declared key', async () => {
    delete process.env.JWT_SECRET;
    delete process.env.API_KEYS;
    const preload = jest.fn(() => {
      process.env.JWT_SECRET = 'vault-supplied-secret-at-least-32-chars';
      process.env.API_KEYS = '{"k":{"secret":"s","tenantId":"t"}}';
      return Promise.resolve(2);
    });

    const moduleRef = await Test.createTestingModule({
      imports: [await validatedConfigModule(preload)],
    }).compile();
    const config = moduleRef.get(ConfigService);

    expect(preload).toHaveBeenCalledTimes(1);
    expect(config.get('JWT_SECRET')).toBe(
      'vault-supplied-secret-at-least-32-chars',
    );
    expect(config.get('API_KEYS')).toBe('{"k":{"secret":"s","tenantId":"t"}}');
  });
});
