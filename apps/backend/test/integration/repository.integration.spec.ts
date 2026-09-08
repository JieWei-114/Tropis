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
      await model.syncIndexes();
    });

    afterAll(async () => {
      await moduleRef?.close();
      await mongo?.stop();
    });

    beforeEach(async () => {
      await model.deleteMany({});
    });

    const base = { name: 'Bob', email: 'bob@example.com', passwordHash: 'x' };

    it('creates and finds a user (defaults applied)', async () => {
      const created = await repo.create(base);
      expect(created.tenantId).toBe('default');
      expect(created.status).toBe(UserStatus.ACTIVE);
      expect(created.deletedAt).toBeNull();

      const byId = await repo.findById(created._id.toString());
      expect(byId!.email).toBe('bob@example.com');

      const byEmail = await repo.findByEmail('bob@example.com');
      expect(byEmail!._id.toString()).toBe(created._id.toString());

      // passwordHash hidden by default, exposed via the auth-only query
      expect(byEmail!.passwordHash).toBeUndefined();
      const withPw = await repo.findByEmailWithPassword('bob@example.com');
      expect(withPw!.passwordHash).toBe('x');
    });

    it('updates a user', async () => {
      const created = await repo.create(base);
      const updated = await repo.update(created._id.toString(), {
        name: 'Bobby',
        age: 30,
      });
      expect(updated!.name).toBe('Bobby');
      expect(updated!.age).toBe(30);
    });

    it('soft deletes: hidden from queries but still in the collection', async () => {
      const created = await repo.create(base);
      const id = created._id.toString();

      const deleted = await repo.delete(id);
      expect(deleted!.deletedAt).toBeInstanceOf(Date);

      // filtered out of all normal reads
      expect(await repo.findById(id)).toBeNull();
      expect(await repo.findByEmail(base.email)).toBeNull();
      expect((await repo.findAll(1, 10)).total).toBe(0);

      // ... but the raw document survives for audit
      expect(await model.countDocuments({ _id: id }).exec()).toBe(1);

      // hard delete removes it entirely
      await repo.hardDelete(id);
      expect(await model.countDocuments({ _id: id }).exec()).toBe(0);
    });

    it('enforces email uniqueness per tenant', async () => {
      await repo.create(base);
      await expect(repo.create({ ...base, name: 'Imposter' })).rejects.toThrow(
        /E11000|duplicate key/i,
      );
      // same email in a different tenant is fine
      await expect(
        repo.create({ ...base, tenantId: 'tenant-b' }),
      ).resolves.toBeDefined();
    });

    it('scopes every query to the tenant', async () => {
      const a = await repo.create({ ...base, tenantId: 'tenant-a' });
      await repo.create({
        name: 'Carol',
        email: 'carol@example.com',
        passwordHash: 'y',
        tenantId: 'tenant-b',
      });

      // cross-tenant reads see nothing
      expect(await repo.findById(a._id.toString(), 'tenant-b')).toBeNull();
      expect(await repo.findByEmail(base.email, 'tenant-b')).toBeNull();

      // list is scoped
      const pageA = await repo.findAll(1, 10, 'tenant-a');
      expect(pageA.total).toBe(1);
      expect(pageA.data[0].email).toBe(base.email);

      // cross-tenant update / delete are no-ops
      expect(
        await repo.update(a._id.toString(), { name: 'Hacked' }, 'tenant-b'),
      ).toBeNull();
      expect(await repo.delete(a._id.toString(), 'tenant-b')).toBeNull();
      expect((await repo.findById(a._id.toString(), 'tenant-a'))!.name).toBe(
        'Bob',
      );
    });

    // README documents findPage() as the keyset-pagination pattern to prefer
    // at scale, but nothing called it and nothing covered it — so the claim
    // was unverified. This walks a real collection page by page.
    it('paginates by cursor, stable and without overlap', async () => {
      const tenant = 'tenant-page';
      for (let i = 0; i < 5; i++) {
        await repo.create({
          ...base,
          email: `page-${i}@example.com`,
          name: `Page ${i}`,
          tenantId: tenant,
        });
      }

      const first = await repo.findPage(2, tenant);
      expect(first.data).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const second = await repo.findPage(2, tenant, first.nextCursor!);
      expect(second.data).toHaveLength(2);
      expect(second.hasMore).toBe(true);

      const third = await repo.findPage(2, tenant, second.nextCursor!);
      expect(third.data).toHaveLength(1);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();

      // No document may appear on two pages, and all five must be seen once.
      const seen = [...first.data, ...second.data, ...third.data].map((d) =>
        d._id.toString(),
      );
      expect(new Set(seen).size).toBe(5);

      // Cursor pages are tenant-scoped like every other read.
      expect((await repo.findPage(10, 'tenant-other')).data).toHaveLength(0);
    });
  },
);
