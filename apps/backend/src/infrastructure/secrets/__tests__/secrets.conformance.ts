import {
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { SecretsPort } from '../secrets.port';

/** A secret the live target was seeded with before make() resolves. */
export interface SeededSecret {
  path: string;
  key: string;
  value: string;
}

export interface SecretsConformanceTargets {
  live: ConformanceTarget<SecretsPort> & {
    seeded: SeededSecret;
    /** Name of a usable encryption key, or null when the adapter has no key store. */
    encryptionKey: string | null;
  };
  /** A port whose backing store cannot be reached, when the adapter has one. */
  unreachable?: ConformanceTarget<SecretsPort>;
}

/**
 * Behaviour every SecretsPort adapter must share: a seeded secret reads
 * back, anything absent resolves null, encryption either round-trips
 * through ciphertext that differs from the plaintext or is unavailable
 * (both directions null, so callers redact), a ciphertext that was not
 * produced by encrypt() never decrypts, and a store that cannot answer
 * reports down and resolves null everywhere instead of throwing.
 */
export function describeSecretsPort(
  adapter: string,
  targets: SecretsConformanceTargets,
): void {
  describe(`SecretsPort conformance: ${adapter}`, () => {
    const live = targets.live;

    describe('with a reachable store', () => {
      let secrets: SecretsPort;

      beforeAll(async () => {
        secrets = await live.make();
      });

      afterAll(async () => {
        await live.teardown?.(secrets);
      });

      it('reports up', async () => {
        expect((await secrets.health()).status).toBe('up');
      });

      it('reads a seeded secret', async () => {
        await expect(
          secrets.getSecret(live.seeded.path, live.seeded.key),
        ).resolves.toBe(live.seeded.value);
      });

      it('resolves null for a missing key', async () => {
        await expect(
          secrets.getSecret(live.seeded.path, `MISSING_${uniqueId()}`),
        ).resolves.toBeNull();
      });

      if (live.encryptionKey) {
        const keyName = live.encryptionKey;

        it('round-trips plaintext through ciphertext that hides it', async () => {
          const plaintext = `user-${uniqueId()}@example.test`;
          const ciphertext = await secrets.encrypt(keyName, plaintext);
          expect(ciphertext).toEqual(expect.any(String));
          expect(ciphertext).not.toContain(plaintext);
          await expect(secrets.decrypt(keyName, ciphertext!)).resolves.toBe(
            plaintext,
          );
        });

        it('encrypts the same plaintext to different ciphertexts', async () => {
          const a = await secrets.encrypt(keyName, 'same');
          const b = await secrets.encrypt(keyName, 'same');
          expect(a).not.toBe(b);
        });

        it('resolves null for a ciphertext it did not produce', async () => {
          await expect(
            secrets.decrypt(keyName, 'vault:v1:bm90LWEtY2lwaGVydGV4dA=='),
          ).resolves.toBeNull();
        });
      } else {
        it('has no key store, so encrypt and decrypt resolve null', async () => {
          await expect(secrets.encrypt('any', 'a@b.c')).resolves.toBeNull();
          await expect(
            secrets.decrypt('any', 'vault:v1:x'),
          ).resolves.toBeNull();
        });
      }

      it('resolves null when no dynamic database credentials are issued', async () => {
        await expect(
          secrets.getDynamicDbCredentials(`no-such-role-${uniqueId()}`),
        ).resolves.toBeNull();
      });
    });

    const unreachable = targets.unreachable;
    if (unreachable) {
      describe('with an unreachable store', () => {
        let secrets: SecretsPort;

        beforeAll(async () => {
          secrets = await unreachable.make();
        });

        afterAll(async () => {
          await unreachable.teardown?.(secrets);
        });

        it('reports down', async () => {
          expect((await secrets.health()).status).toBe('down');
        });

        it('resolves null everywhere instead of throwing', async () => {
          await expect(
            secrets.getSecret(live.seeded.path, live.seeded.key),
          ).resolves.toBeNull();
          await expect(secrets.encrypt('any', 'a@b.c')).resolves.toBeNull();
          await expect(
            secrets.decrypt('any', 'vault:v1:x'),
          ).resolves.toBeNull();
          await expect(secrets.getDynamicDbCredentials()).resolves.toBeNull();
        });
      });
    }
  });
}
