import { Schema, type Connection, type Model } from 'mongoose';
import type { TenantId } from '../../../common/keyspace';
import { runGlobal } from '../../../common/tenant/tenant.context';
import {
  TENANT_A,
  TENANT_B,
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { DocumentsPort } from '../documents.port';
import {
  DocumentTenancyError,
  TenantScopedRepository,
  tenantScopePlugin,
} from '../tenant-scope';

export interface DocumentsFixture {
  port: DocumentsPort;
  /** The connection the port probes; closed by the last test. */
  connection: Connection;
}

interface Note {
  tenantId: string;
  body: string;
}

class NoteRepository extends TenantScopedRepository<Note> {
  constructor(model: Model<Note>) {
    super(model);
  }

  list(tenantId: TenantId) {
    return this.find(tenantId).sort({ body: 1 }).lean().exec();
  }

  add(tenantId: TenantId, data: Partial<Note>) {
    return this.insert(tenantId, data);
  }

  count(tenantId: TenantId, filter: Record<string, unknown> = {}) {
    return this.countDocuments(tenantId, filter).exec();
  }
}

/**
 * Behaviour every documents adapter must share: its health, and the tenant
 * fence (tenantScopePlugin + TenantScopedRepository) every module's
 * repositories rely on, proven on the adapter's real connection.
 */
export function describeDocumentsPort(
  adapter: string,
  target: ConformanceTarget<DocumentsFixture>,
): void {
  describe(`DocumentsPort conformance: ${adapter}`, () => {
    let fixture: DocumentsFixture;
    let model: Model<Note>;
    let repo: NoteRepository;

    beforeAll(async () => {
      fixture = await target.make();
      const schema = new Schema<Note>({
        tenantId: String,
        body: { type: String, required: true },
      });
      schema.plugin(tenantScopePlugin);
      model = fixture.connection.model<Note>(
        `ConformanceNote${uniqueId().slice(0, 8)}`,
        schema,
      );
      repo = new NoteRepository(model);
      await repo.add(TENANT_A, { body: 'a1' });
      await repo.add(TENANT_A, { body: 'a2' });
      await repo.add(TENANT_B, { body: 'b1' });
    });

    afterAll(async () => {
      await target.teardown?.(fixture);
    });

    it('reports up', async () => {
      expect((await fixture.port.health()).status).toBe('up');
    });

    it("returns only the tenant's documents", async () => {
      expect((await repo.list(TENANT_A)).map((d) => d.body)).toEqual([
        'a1',
        'a2',
      ]);
      expect((await repo.list(TENANT_B)).map((d) => d.body)).toEqual(['b1']);
    });

    it('rejects a query without a tenant filter', async () => {
      await expect(model.find({}).exec()).rejects.toThrow(DocumentTenancyError);
      await expect(model.countDocuments({ body: 'b1' }).exec()).rejects.toThrow(
        DocumentTenancyError,
      );
    });

    it('rejects an update that changes the tenant', async () => {
      await expect(
        model
          .updateOne(
            { tenantId: TENANT_A, body: 'a1' },
            { $set: { tenantId: TENANT_B } },
          )
          .exec(),
      ).rejects.toThrow(DocumentTenancyError);
      expect(await repo.count(TENANT_B)).toBe(1);
    });

    it('rejects an insert without a tenant', async () => {
      await expect(model.create({ body: 'orphan' })).rejects.toThrow(
        DocumentTenancyError,
      );
      await expect(model.insertMany([{ body: 'orphan' }])).rejects.toThrow(
        DocumentTenancyError,
      );
    });

    it('rejects an aggregation that does not match on the tenant first', async () => {
      await expect(model.aggregate([{ $match: {} }]).exec()).rejects.toThrow(
        DocumentTenancyError,
      );
      const rows = await model
        .aggregate<{
          n: number;
        }>([{ $match: { tenantId: TENANT_A } }, { $count: 'n' }])
        .exec();
      expect(rows).toEqual([{ n: 2 }]);
    });

    it('rejects a repository filter or document naming another tenant', async () => {
      const attempt = (fn: () => Promise<unknown>) =>
        expect(Promise.resolve().then(fn)).rejects.toThrow(
          DocumentTenancyError,
        );
      await attempt(() => repo.count(TENANT_A, { tenantId: TENANT_B }));
      await attempt(() =>
        repo.add(TENANT_A, { tenantId: TENANT_B, body: 'x' }),
      );
      await attempt(() => repo.list('bad tenant' as TenantId));
    });

    it('lets an explicit global scope query across tenants', async () => {
      const all = await runGlobal(() => model.countDocuments({}).exec());
      expect(all).toBe(3);
    });

    it('reports down once the connection is closed', async () => {
      await fixture.connection.close();
      expect((await fixture.port.health()).status).toBe('down');
    });
  });
}
