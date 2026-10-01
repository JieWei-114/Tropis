import { capabilityDown } from '../capability-status';
import { envValidationSchema } from '../../../config/env.validation';
import { MAIL_ADAPTERS } from '../../mail/mail.port';
import { OBJECTS_ADAPTERS } from '../../objects/objects.port';
import { OLAP_ADAPTERS } from '../../olap/olap.port';
import { SEARCH_ADAPTERS } from '../../search/search.port';
import { SECRETS_ADAPTERS } from '../../secrets/secrets.port';
import { SIGNING_ADAPTERS } from '../../signing/signing.port';
import { VECTOR_ADAPTERS } from '../../vector/vector.port';
import { WORKFLOW_ADAPTERS } from '../../workflow/workflow.port';

const base = { JWT_SECRET: 'x'.repeat(32) };

describe('adapter selectors in env validation', () => {
  it.each([
    ['VECTOR_ADAPTER', VECTOR_ADAPTERS, 'pgvector'],
    ['SEARCH_ADAPTER', SEARCH_ADAPTERS, 'elasticsearch'],
    ['OLAP_ADAPTER', OLAP_ADAPTERS, 'clickhouse'],
    ['OBJECTS_ADAPTER', OBJECTS_ADAPTERS, 'minio'],
    ['WORKFLOW_ADAPTER', WORKFLOW_ADAPTERS, 'temporal'],
    ['SECRETS_ADAPTER', SECRETS_ADAPTERS, 'vault'],
    ['MAIL_ADAPTER', MAIL_ADAPTERS, 'smtp'],
    ['SIGNING_ADAPTER', SIGNING_ADAPTERS, 'inprocess'],
  ] as const)(
    '%s accepts exactly its adapters, default %s',
    (name, adapters, fallback) => {
      const { value } = envValidationSchema.validate(base) as {
        value: Record<string, string>;
      };
      expect(value[name]).toBe(fallback);
      for (const adapter of adapters) {
        expect(
          envValidationSchema.validate({ ...base, [name]: adapter }).error,
        ).toBeUndefined();
      }
      expect(
        envValidationSchema.validate({ ...base, [name]: 'unknown' }).error,
      ).toBeDefined();
    },
  );
});

describe('capabilityDown', () => {
  it('names a connection failure whose message is empty', () => {
    const err = Object.assign(new AggregateError([], ''), {
      code: 'ECONNREFUSED',
    });
    expect(capabilityDown('clickhouse', err).message).toBe('ECONNREFUSED');
  });
});
