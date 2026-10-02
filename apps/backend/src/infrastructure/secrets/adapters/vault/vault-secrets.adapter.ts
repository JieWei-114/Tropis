/**
 * Secrets adapter for HashiCorp Vault: KV v2 + AppRole auth + token renewal +
 * Transit encryption + database secrets engine.
 *
 * Auth flow:
 *
 *   Static token (dev)
 *     VAULT_TOKEN present → use directly (dev-root-token or app token from init script)
 *
 *   AppRole (staging / production)
 *     VAULT_ROLE_ID + VAULT_SECRET_ID → POST /v1/auth/approle/login → scoped token
 *     Token is short-lived (1h) and renewed automatically.
 *     CI/CD injects VAULT_SECRET_ID at deploy time — never stored in files.
 *
 *   Kubernetes (cloud-native)
 *     Use Vault Agent sidecar or Vault Secrets Operator instead.
 *     They handle auth + renewal + injection without any app-level code.
 *
 * Secret loading:
 *   The KV secrets at VAULT_SECRET_PATH are merged into process.env before
 *   the config schema is validated (vault-env-loader.ts, run by the config
 *   module), not by this adapter: by the time it initialises, config has
 *   already been read.
 */

import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createLogger } from '../../../../common/observability/logger';
import {
  capabilityDisabled,
  capabilityDown,
  probeCapability,
  type CapabilityHealth,
} from '../../../capability';
import { VAULT_REQUEST_TIMEOUT_MS } from './vault-env-loader';
import type { DatabaseCredentials, SecretsPort } from '../../secrets.port';

interface VaultClient {
  health(): Promise<unknown>;
  read(path: string): Promise<{
    data?: {
      data?: Record<string, string>;
      lease_duration?: number;
      username?: string;
      password?: string;
    };
  }>;
  write(
    path: string,
    data: Record<string, unknown>,
  ): Promise<{
    auth?: { client_token: string; lease_duration: number };
    data?: { ciphertext?: string; plaintext?: string };
  }>;
  token: {
    renewSelf(body?: Record<string, unknown>): Promise<{
      auth?: { lease_duration?: number };
    }>;
  };
}

export type VaultFactory = (options: {
  endpoint: string;
  token?: string;
}) => VaultClient;

const nodeVault: VaultFactory = (options) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node-vault') as (o: Record<string, unknown>) => VaultClient)({
    ...options,
    requestOptions: { timeout: VAULT_REQUEST_TIMEOUT_MS },
  });

/** Pause before authenticating again after a failed login. */
export const VAULT_RELOGIN_INTERVAL_MS = 30_000;

/** Lease extension requested on each renewal — must match the reschedule. */
const RENEW_INCREMENT = '1h';
/** Seconds in RENEW_INCREMENT — the renewal interval must stay below it. */
const RENEW_INCREMENT_SECONDS = 60 * 60;

export class VaultSecretsAdapter
  implements SecretsPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger('secrets');
  private client: VaultClient | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;
  private reloginTimer: NodeJS.Timeout | null = null;
  /** Why the configured Vault has no client, while it has none. */
  private failure: unknown = null;

  constructor(
    private readonly config: ConfigService,
    private readonly NodeVault: VaultFactory = nodeVault,
  ) {}

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async onModuleInit() {
    const addr = this.config.get<string>('VAULT_ADDR');
    if (!addr) {
      this.logger.warn(
        'vault-disabled',
        'VAULT_ADDR is not set; Vault is disabled and .env values apply',
      );
      return;
    }

    await this.connect(addr);
  }

  onModuleDestroy(): Promise<void> {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    if (this.reloginTimer) clearTimeout(this.reloginTimer);
    this.renewalTimer = null;
    this.reloginTimer = null;
    return Promise.resolve();
  }

  /**
   * Authenticates; on failure reports down and tries again every
   * VAULT_RELOGIN_INTERVAL_MS, so the adapter recovers once Vault is back.
   */
  private async connect(addr: string): Promise<void> {
    try {
      await this.authenticate(addr);
      this.failure = null;
    } catch (err) {
      this.logger.warn(
        'vault-unavailable',
        'Vault is unavailable; Vault-backed operations degrade until it is back',
        {},
        err,
      );
      this.client = null;
      this.failure = err;
      if (this.renewalTimer) clearInterval(this.renewalTimer);
      this.renewalTimer = null;
      if (this.reloginTimer) clearTimeout(this.reloginTimer);
      this.reloginTimer = setTimeout(() => {
        this.reloginTimer = null;
        void this.connect(addr);
      }, VAULT_RELOGIN_INTERVAL_MS);
      this.reloginTimer.unref?.();
    }
  }

  // ── Authentication ────────────────────────────────────────────────────────

  private async authenticate(addr: string): Promise<void> {
    const staticToken = this.config.get<string>('VAULT_TOKEN');
    const roleId = this.config.get<string>('VAULT_ROLE_ID');
    const secretId = this.config.get<string>('VAULT_SECRET_ID');

    if (roleId && secretId) {
      await this.loginAppRole(addr, roleId, secretId);
    } else if (staticToken) {
      this.client = this.NodeVault({ endpoint: addr, token: staticToken });
      await this.client.health();
      this.logger.info('vault-connected', 'Vault connected', {
        'vault.auth_method': 'token',
      });
      // A static token's initial TTL is irrelevant: the first renewal resets
      // the lease to RENEW_INCREMENT, so every later renewal must land inside
      // that window. Interval is derived from the increment for that reason —
      // an interval longer than it lets the token expire between renewals.
      this.scheduleRenewal(this.renewIntervalFor(RENEW_INCREMENT_SECONDS));
    } else {
      throw new Error(
        'No Vault credentials — set VAULT_TOKEN or VAULT_ROLE_ID + VAULT_SECRET_ID',
      );
    }
  }

  private async loginAppRole(
    addr: string,
    roleId: string,
    secretId: string,
  ): Promise<void> {
    // Create a temporary client without token just to call the login endpoint
    const loginClient = this.NodeVault({ endpoint: addr });

    const res = await loginClient.write('auth/approle/login', {
      role_id: roleId,
      secret_id: secretId,
    });

    const token = res.auth?.client_token;
    const ttlSecs = res.auth?.lease_duration ?? 3600;

    if (!token) throw new Error('AppRole login returned no token');

    this.client = this.NodeVault({ endpoint: addr, token });
    this.logger.info('vault-connected', 'Vault connected', {
      'vault.auth_method': 'approle',
      'vault.token_ttl_s': ttlSecs,
    });

    // Renew at 1/3 of TTL so we never get close to expiry
    this.scheduleRenewal(this.renewIntervalFor(ttlSecs));
  }

  // ── Token renewal (keeps the app running past the initial TTL) ────────────

  /** Renew at 1/3 of the lease, clamped so we always renew well before expiry. */
  private renewIntervalFor(ttlSecs: number): number {
    return Math.max(30, Math.floor(ttlSecs / 3));
  }

  private scheduleRenewal(intervalSecs: number) {
    if (this.renewalTimer) clearInterval(this.renewalTimer);

    this.renewalTimer = setInterval(
      () => void this.renew(intervalSecs),
      intervalSecs * 1000,
    );
  }

  private async renew(intervalSecs: number): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.token.renewSelf({
        increment: RENEW_INCREMENT,
      });
      this.logger.debug('token-renewed', 'Vault token renewed');

      // Reschedule from the ACTUAL renewed lease, not the initial TTL:
      // renewSelf resets the lease to RENEW_INCREMENT, so an interval pinned
      // to a longer initial TTL (e.g. 6h → every 2h) would fire on a token
      // that only lives 1h. The token then expires unnoticed and every
      // Vault-dependent path degrades and audit-log emails are redacted.
      const renewedTtl = res?.auth?.lease_duration;
      if (typeof renewedTtl === 'number' && renewedTtl > 0) {
        const next = this.renewIntervalFor(renewedTtl);
        if (next !== intervalSecs) this.scheduleRenewal(next);
      }
    } catch (err) {
      // An AppRole token past its max TTL cannot be renewed: log in again.
      const addr = this.config.get<string>('VAULT_ADDR');
      const appRole =
        this.config.get<string>('VAULT_ROLE_ID') &&
        this.config.get<string>('VAULT_SECRET_ID');
      this.logger.warn(
        'token-renewal-failed',
        appRole
          ? 'Vault token renewal failed; logging in again'
          : 'Vault token renewal failed',
        {},
        err,
      );
      if (appRole && addr) await this.connect(addr);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Read a single secret value at runtime (e.g. after rotation). */
  async getSecret(path: string, key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.read(path);
      return res?.data?.data?.[key] ?? null;
    } catch {
      return null;
    }
  }

  /** Encrypt plaintext via Vault Transit engine. Returns vault:v1:... ciphertext. */
  async encrypt(keyName: string, plaintext: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const b64 = Buffer.from(plaintext).toString('base64');
      const res = await this.client.write(`transit/encrypt/${keyName}`, {
        plaintext: b64,
      });
      return res?.data?.ciphertext ?? null;
    } catch (err) {
      this.logger.error(
        'transit-encrypt-failed',
        'Vault transit encrypt failed',
        err,
        { 'vault.transit_key': keyName },
      );
      return null;
    }
  }

  /** Decrypt ciphertext via Vault Transit engine. Returns original plaintext. */
  async decrypt(keyName: string, ciphertext: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.write(`transit/decrypt/${keyName}`, {
        ciphertext,
      });
      const b64 = res?.data?.plaintext;
      return b64 ? Buffer.from(b64, 'base64').toString('utf8') : null;
    } catch (err) {
      this.logger.error(
        'transit-decrypt-failed',
        'Vault transit decrypt failed',
        err,
        { 'vault.transit_key': keyName },
      );
      return null;
    }
  }

  /** Request dynamic PostgreSQL credentials from Vault database engine. */
  async getDynamicDbCredentials(
    roleName = 'tropis-app',
  ): Promise<DatabaseCredentials | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.read(`database/creds/${roleName}`);
      const { username, password } = res?.data ?? {};
      if (!username || !password) return null;
      this.logger.info(
        'db-credentials-issued',
        'Dynamic database credentials issued',
        { 'vault.db_role': roleName },
      );
      return { username, password };
    } catch (err) {
      this.logger.warn(
        'db-credentials-unavailable',
        'Dynamic database credentials unavailable',
        { 'vault.db_role': roleName },
        err,
      );
      return null;
    }
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * `disabled` when VAULT_ADDR is unset; `down` while a configured Vault
   * could not be authenticated against; otherwise a live probe of the
   * Vault server.
   */
  health(): Promise<CapabilityHealth> {
    const client = this.client;
    if (!client) {
      return Promise.resolve(
        this.failure !== null
          ? capabilityDown('vault', this.failure)
          : capabilityDisabled(),
      );
    }
    return probeCapability('vault', () => client.health());
  }
}
