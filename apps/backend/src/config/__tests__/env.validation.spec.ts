import { envValidationSchema } from '../env.validation';

const base = { JWT_SECRET: 'x'.repeat(32) };

describe('env validation', () => {
  describe('AEROSPIKE_HOSTS', () => {
    it('defaults to the host:port list the connection reads', () => {
      const { value } = envValidationSchema.validate(base) as {
        value: Record<string, unknown>;
      };
      expect(value.AEROSPIKE_HOSTS).toBe('localhost:3000');
      expect(value).not.toHaveProperty('AEROSPIKE_HOST');
      expect(value).not.toHaveProperty('AEROSPIKE_PORT');
    });

    it.each(['aerospike:3000', 'a:3000,b:3001'])('accepts %s', (hosts) => {
      expect(
        envValidationSchema.validate({ ...base, AEROSPIKE_HOSTS: hosts }).error,
      ).toBeUndefined();
    });

    it.each(['localhost', 'a:3000,', 'a:x'])('rejects %s', (hosts) => {
      expect(
        envValidationSchema.validate({ ...base, AEROSPIKE_HOSTS: hosts }).error,
      ).toBeDefined();
    });
  });

  describe('API_KEYS', () => {
    const check = (value: string) =>
      envValidationSchema.validate({ ...base, API_KEYS: value }).error;

    it('accepts tenant-bound keys', () => {
      expect(check('{"svc":{"secret":"s","tenantId":"acme"}}')).toBeUndefined();
      expect(check('{}')).toBeUndefined();
    });

    it.each([
      'not-json',
      '{"svc":"bare-secret"}',
      '{"svc":{"secret":"s"}}',
      '{"svc":{"secret":"s","tenantId":"bad tenant"}}',
    ])('rejects %s', (value) => {
      expect(check(value)).toBeDefined();
    });
  });
});
