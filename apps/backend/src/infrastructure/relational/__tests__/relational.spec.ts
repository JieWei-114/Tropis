import { toTenantId } from '../../../common/keyspace';
import {
  RelationalTenancyError,
  TypeOrmRelationalAdapter,
  tenantIsolationStatements,
} from '../adapters/typeorm/typeorm-relational.adapter';
import {
  RELATIONAL_TENANT_ROLE,
  RELATIONAL_TENANT_SETTING,
} from '../relational.port';

describe('TypeOrmRelationalAdapter', () => {
  it('passes SQL and positional parameters through', async () => {
    const query = jest.fn().mockResolvedValue([{ a: 1 }]);
    const adapter = new TypeOrmRelationalAdapter({ query } as never);
    await expect(adapter.query('SELECT $1', [1])).resolves.toEqual([{ a: 1 }]);
    expect(query).toHaveBeenCalledWith('SELECT $1', [1]);
  });

  it('reports down when SELECT 1 fails', async () => {
    const adapter = new TypeOrmRelationalAdapter({
      query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);
    await expect(adapter.health()).resolves.toEqual({
      status: 'down',
      adapter: 'postgres',
      message: 'ECONNREFUSED',
    });
  });
});

describe('TypeOrmRelationalAdapter.withTenant', () => {
  const makeRunner = () => {
    const runner = {
      isTransactionActive: false,
      calls: [] as string[],
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        runner.calls.push(`${sql} ${JSON.stringify(params ?? [])}`);
        return [];
      }),
    };
    return runner;
  };

  it('sets the tenant and switches role inside the transaction before running fn', async () => {
    const runner = makeRunner();
    const adapter = new TypeOrmRelationalAdapter({
      createQueryRunner: () => runner,
    } as never);
    await adapter.withTenant(toTenantId('acme'), (tx) =>
      tx.query('SELECT * FROM t'),
    );
    expect(runner.calls).toEqual([
      `SELECT set_config($1, $2, true) ${JSON.stringify([RELATIONAL_TENANT_SETTING, 'acme'])}`,
      `SET LOCAL ROLE ${RELATIONAL_TENANT_ROLE} []`,
      'SELECT * FROM t []',
    ]);
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('rolls back and releases when fn throws', async () => {
    const runner = makeRunner();
    const adapter = new TypeOrmRelationalAdapter({
      createQueryRunner: () => runner,
    } as never);
    await expect(
      adapter.withTenant(toTenantId('acme'), () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('refuses a malformed tenant before opening a connection', async () => {
    const createQueryRunner = jest.fn();
    const adapter = new TypeOrmRelationalAdapter({
      createQueryRunner,
    } as never);
    await expect(
      adapter.withTenant('a b' as never, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(RelationalTenancyError);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects an unsafe table name for isolation DDL', () => {
    expect(() => tenantIsolationStatements('t; DROP TABLE x')).toThrow(
      RelationalTenancyError,
    );
    expect(tenantIsolationStatements('vector_embeddings').join('\n')).toMatch(
      /FORCE ROW LEVEL SECURITY/,
    );
  });
});
