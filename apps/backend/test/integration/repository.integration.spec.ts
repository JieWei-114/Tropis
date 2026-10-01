/**
 * UserRepository integration test — real MongoDB (mongo:7).
 * Covers CRUD, the unique (email, tenantId) compound index, soft delete,
 * and tenant scoping — the behavior unit tests with mocked models can't
 * honestly verify.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { UserRepository } from '../../src/modules/user/repositories/user.repository';
import {
  User,
  UserSchema,
  UserStatus,
} from '../../src/modules/user/schemas/user.schema';
import { describeWithDocker } from './docker';
import { toTenantId } from '../../src/common/keyspace';
import { runGlobal } from '../../src/common/tenant/tenant.context';

const A = toTenantId('tenant-a');
const B = toTenantId('tenant-b');

jest.setTimeout(240_000);

describeWithDocker('UserRepository (integration)')(
  'UserRepository (integration)',
  () => {
    let mongo: StartedMongoDBContainer;
    let moduleRef: TestingModule;
    let repo: UserRepository;
    let model: Model<User>;

    beforeAll(async () => {
      mongo = await new MongoDBContainer('mongo:7').start();

      moduleRef = await Test.createTestingModule({
        imports: [
          MongooseModule.forRoot(mongo.getConnectionString(), {
            directConnection: true,
          }),
          MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
        ],
        providers: [UserRepository],
      }).compile();

      await moduleRef.init();

      repo = moduleRef.get(UserRepository);
      model = moduleRef.get(getModelToken(User.name));
      // Ensure the unique compound index actually exists before testing it
      await runGlobal(() => model.syncIndexes());
    });

    afterAll(async () => {
      await moduleRef?.close();
      await mongo?.stop();
    });

    beforeEach(async () => {
      await runGlobal(() => model.deleteMany({}).exec());
    });

    const base = { name: 'Bob', email: 'bob@example.com', passwordHash: 'x' };

    it('creates and finds a user (defaults applied)', async () => {
      const created = await repo.create(A, base);
      expect(created.tenantId).toBe('tenant-a');
      expect(created.status).toBe(UserStatus.ACTIVE);
      expect(created.deletedAt).toBeNull();

      const byId = await repo.findById(A, created._id.toString());
      expect(byId!.email).toBe('bob@example.com');

      const byEmail = await repo.findByEmail(A, 'bob@example.com');
      expect(byEmail!._id.toString()).toBe(created._id.toString());

      // passwordHash hidden by default, exposed via the auth-only query
      expect(byEmail!.passwordHash).toBeUndefined();
      const withPw = await repo.findByEmailWithPassword(A, 'bob@example.com');
      expect(withPw!.passwordHash).toBe('x');
    });

    it('updates a user', async () => {
      const created = await repo.create(A, base);
      const updated = await repo.update(A, created._id.toString(), {
        name: 'Bobby',
        age: 30,
      });
      expect(updated!.name).toBe('Bobby');
      expect(updated!.age).toBe(30);
    });

    it('soft deletes: hidden from queries but still in the collection', async () => {
      const created = await repo.create(A, base);
      const id = created._id.toString();

      const deleted = await repo.delete(A, id);
      expect(deleted!.deletedAt).toBeInstanceOf(Date);

      // filtered out of all normal reads
      expect(await repo.findById(A, id)).toBeNull();
      expect(await repo.findByEmail(A, base.email)).toBeNull();
      expect((await repo.findAll(A, 1, 10)).total).toBe(0);

      // ... but the raw document survives for audit
      expect(await model.countDocuments({ _id: id, tenantId: A }).exec()).toBe(
        1,
      );

      // hard delete removes it entirely
      await repo.hardDelete(A, id);
      expect(await model.countDocuments({ _id: id, tenantId: A }).exec()).toBe(
        0,
      );
    });

    it('enforces email uniqueness per tenant', async () => {
      await repo.create(A, base);
      await expect(
        repo.create(A, { ...base, name: 'Imposter' }),
      ).rejects.toThrow(/E11000|duplicate key/i);
      // same email in a different tenant is fine
      await expect(repo.create(B, base)).resolves.toBeDefined();
    });

    it('scopes every query to the tenant', async () => {
      const a = await repo.create(A, base);
      await repo.create(B, {
        name: 'Carol',
        email: 'carol@example.com',
        passwordHash: 'y',
      });

      // cross-tenant reads see nothing
      expect(await repo.findById(B, a._id.toString())).toBeNull();
      expect(await repo.findByEmail(B, base.email)).toBeNull();

      // list is scoped
      const pageA = await repo.findAll(A, 1, 10);
      expect(pageA.total).toBe(1);
      expect(pageA.data[0].email).toBe(base.email);

      // cross-tenant update / delete are no-ops
      expect(
        await repo.update(B, a._id.toString(), { name: 'Hacked' }),
      ).toBeNull();
      expect(await repo.delete(B, a._id.toString())).toBeNull();
      await repo.incrementLoginCount(B, a._id.toString());
      const stillA = await repo.findById(A, a._id.toString());
      expect(stillA!.name).toBe('Bob');
      expect(stillA!.loginCount).toBe(0);
    });

    it('rejects any query or insert that names no tenant (schema fence)', async () => {
      await repo.create(A, base);
      await expect(model.find({ email: base.email }).exec()).rejects.toThrow(
        /tenant/i,
      );
      await expect(
        model.updateOne({ email: base.email }, { name: 'x' }).exec(),
      ).rejects.toThrow(/tenant/i);
      await expect(
        model.aggregate([{ $match: { email: base.email } }]).exec(),
      ).rejects.toThrow(/tenant/i);
      await expect(
        model.create({ name: 'N', email: 'n@example.com', passwordHash: 'x' }),
      ).rejects.toThrow(/tenant/i);
      await expect(
        model.updateOne({ tenantId: A }, { tenantId: B }).exec(),
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        runGlobal(() => model.countDocuments({}).exec()),
      ).resolves.toBe(1);
    });

    // README documents findPage() as the keyset-pagination pattern to prefer
    // at scale, but nothing called it and nothing covered it — so the claim
    // was unverified. This walks a real collection page by page.
    it('paginates by cursor, stable and without overlap', async () => {
      const tenant = toTenantId('tenant-page');
      for (let i = 0; i < 5; i++) {
        await repo.create(tenant, {
          ...base,
          email: `page-${i}@example.com`,
          name: `Page ${i}`,
        });
      }

      const first = await repo.findPage(tenant, 2);
      expect(first.data).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const second = await repo.findPage(tenant, 2, first.nextCursor!);
      expect(second.data).toHaveLength(2);
      expect(second.hasMore).toBe(true);

      const third = await repo.findPage(tenant, 2, second.nextCursor!);
      expect(third.data).toHaveLength(1);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();

      // No document may appear on two pages, and all five must be seen once.
      const seen = [...first.data, ...second.data, ...third.data].map((d) =>
        d._id.toString(),
      );
      expect(new Set(seen).size).toBe(5);

      // Cursor pages are tenant-scoped like every other read.
      expect(
        (await repo.findPage(toTenantId('tenant-other'), 10)).data,
      ).toHaveLength(0);
    });
  },
);
