/**
 * VaultService — HashiCorp Vault KV v2 + AppRole auth + token renewal.
 *
 * Auth flow (production pattern):
 *
 *   Static token (dev)
 *     VAULT_TOKEN present → use directly (dev-root-token or app token from init script)
 *
 *   AppRole (staging / production)
 *     VAULT_ROLE_ID + VAULT_SECRET_ID → POST /v1/auth/approle/login → scoped token
 *     Token is short-lived (1h). VaultService renews it every 20 min automatically.
 *     CI/CD injects VAULT_SECRET_ID at deploy time — never stored in files.
 *
 *   Kubernetes (cloud-native)
 *     Use Vault Agent sidecar or Vault Secrets Operator instead.
 *     They handle auth + renewal + injection without any app-level code.
 *
 * Secret loading:
 *   All secrets at VAULT_SECRET_PATH are fetched at bootstrap and merged
 *   into process.env. NestJS ConfigModule reads process.env as normal.
 *   Only keys not already set in the environment are injected (env vars
 *   can still override Vault for local overrides).
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeVault = require('node-vault');

interface VaultClient {
  health(): Promise<unknown>;
  read(path: string): Promise<{
    data?: { data?: Record<string, string>; lease_duration?: number };
  }>;
  write(
    path: string,
    data: Record<string, unknown>,
  ): Promise<{ auth?: { client_token: string; lease_duration: number } }>;
  token: { renewSelf(body?: Record<string, unknown>): Promise<unknown> };
}

@Injectable()
export class VaultService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VaultService.name);
  private client: VaultClient | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {}

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async onModuleInit() {
    const addr = this.config.get<string>('VAULT_ADDR');
    if (!addr) {
      this.logger.warn(
        'VAULT_ADDR not set — Vault disabled, using .env values',
      );
      return;
    }

    try {
      await this.authenticate(addr);
      await this.loadSecrets();
    } catch (err) {
      this.logger.warn(
        `Vault unavailable (${(err as Error).message}) — falling back to .env`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy() {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
  }

  // ── Authentication ────────────────────────────────────────────────────────

  private async authenticate(addr: string): Promise<void> {
    const staticToken = this.config.get<string>('VAULT_TOKEN');
    const roleId = this.config.get<string>('VAULT_ROLE_ID');
    const secretId = this.config.get<string>('VAULT_SECRET_ID');

    if (roleId && secretId) {
      await this.loginAppRole(addr, roleId, secretId);
    } else if (staticToken) {
      this.client = NodeVault({
        endpoint: addr,
        token: staticToken,
      }) as VaultClient;
      await this.client.health();
      this.logger.log(`Vault connected via static token at ${addr}`);
      this.scheduleRenewal(23 * 60); // renew before 24h TTL
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
    const loginClient = NodeVault({ endpoint: addr }) as VaultClient;

    const res = await loginClient.write('auth/approle/login', {
      role_id: roleId,
      secret_id: secretId,
    });

    const token = res.auth?.client_token;
    const ttlSecs = res.auth?.lease_duration ?? 3600;

    if (!token) throw new Error('AppRole login returned no token');

    this.client = NodeVault({ endpoint: addr, token }) as VaultClient;
    this.logger.log(`Vault authenticated via AppRole (TTL: ${ttlSecs}s)`);

    // Renew at 1/3 of TTL so we never get close to expiry
    this.scheduleRenewal(Math.floor(ttlSecs / 3));
  }

  // ── Token renewal (keeps the app running past the initial TTL) ────────────

  private scheduleRenewal(intervalSecs: number) {
    if (this.renewalTimer) clearInterval(this.renewalTimer);

    this.renewalTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        await this.client.token.renewSelf({ increment: '1h' });
        this.logger.debug('Vault token renewed');
      } catch (err) {
        this.logger.warn(
          `Vault token renewal failed: ${(err as Error).message}`,
        );
      }
    }, intervalSecs * 1000);
  }

  // ── Secret loading ────────────────────────────────────────────────────────

  private async loadSecrets(): Promise<void> {
    if (!this.client) return;

    const path = this.config.get<string>(
      'VAULT_SECRET_PATH',
      'secret/data/tropis',
    );

    const res = await this.client.read(path);
    const secrets = res?.data?.data;

    if (!secrets) {
      this.logger.warn(`No secrets at ${path}`);
      return;
    }

    let injected = 0;
    for (const [key, value] of Object.entries(secrets)) {
      if (!process.env[key]) {
        process.env[key] = String(value);
        injected++;
      }
    }

    this.logger.log(`Loaded ${injected} secrets from Vault (${path})`);
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
      const res = (await this.client.write(`transit/encrypt/${keyName}`, {
        plaintext: b64,
      })) as any;
      return res?.data?.ciphertext ?? null;
    } catch (err) {
      this.logger.error(`Transit encrypt failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Decrypt ciphertext via Vault Transit engine. Returns original plaintext. */
  async decrypt(keyName: string, ciphertext: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = (await this.client.write(`transit/decrypt/${keyName}`, {
        ciphertext,
      })) as any;
      const b64 = res?.data?.plaintext;
      return b64 ? Buffer.from(b64, 'base64').toString('utf8') : null;
    } catch (err) {
      this.logger.error(`Transit decrypt failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Request dynamic PostgreSQL credentials from Vault database engine. */
  async getDynamicDbCredentials(
    roleName = 'tropis-app',
  ): Promise<{ username: string; password: string } | null> {
    if (!this.client) return null;
    try {
      const res = (await this.client.read(`database/creds/${roleName}`)) as any;
      const { username, password } = res?.data ?? {};
      if (!username || !password) return null;
      this.logger.log(
        `Dynamic DB credentials issued for role: ${roleName} (user: ${username})`,
      );
      return { username, password };
    } catch (err) {
      this.logger.warn(
        `Dynamic DB credentials unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  get isConnected(): boolean {
    return this.client !== null;
  }
}
