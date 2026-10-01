import type { TenantId } from './tenant-id';
import { isTenantId, InvalidTenantIdError } from './tenant-id';

/**
 * Keyspace standard for every key-addressed capability (cache, kv, lock,
 * ratelimit, dedup).
 *
 *   {app}:{env}:{scope}:{capability}:{module}:{name}:{version}[:{id}...]
 *   tropis:prod:t.acme:cache:user:profile:v1:6650c1
 *
 * - app / env come from KEYSPACE_APP / KEYSPACE_ENV, so two deployments (or
 *   two environments) sharing one server never read each other's keys.
 * - scope is `t.<tenantId>` or the literal `global`; the choice is made by
 *   calling forTenant() or global(), never by string concatenation.
 * - Fixed segments are lowercase, `-` inside a segment, `:` only between
 *   segments. `name` is kebab-case full words.
 * - Ids and tenant ids are percent-escaped, so they keep their case but can
 *   never contain `:` (no segment injection) or glob characters.
 */

export const KEY_CAPABILITIES = [
  'cache',
  'kv',
  'lock',
  'ratelimit',
  'dedup',
] as const;
export type KeyCapability = (typeof KEY_CAPABILITIES)[number];

declare const keyBrand: unique symbol;

/** A fully built key for one capability. Only defineKey() produces these. */
export type Key<C extends KeyCapability> = string & {
  readonly [keyBrand]: C;
};
export type CacheKey = Key<'cache'>;
export type KvKey = Key<'kv'>;
export type LockKey = Key<'lock'>;
export type RateLimitKey = Key<'ratelimit'>;
export type DedupKey = Key<'dedup'>;

export type KeyVersion = `v${number}`;
export type KeyId = string | number;

export interface KeySpec<C extends KeyCapability> {
  capability: C;
  /** Owning module, e.g. `user`. */
  module: string;
  /** What the key holds, kebab-case full words, e.g. `profile`. */
  name: string;
  /** Bump when the stored shape changes, so old values are never misread. */
  version: KeyVersion;
}

export interface KeyspaceSettings {
  app: string;
  env: string;
}

export interface KeyBuilder<C extends KeyCapability> {
  readonly spec: Readonly<KeySpec<C>>;
  /** Key scoped to one tenant: `...:t.<tenantId>:...`. */
  forTenant(tenantId: TenantId, ...ids: KeyId[]): Key<C>;
  /** Key shared by all tenants: `...:global:...`. Named apart on purpose. */
  global(...ids: KeyId[]): Key<C>;
  /** Same definition under an explicit app/env instead of the configured one. */
  withKeyspace(settings: KeyspaceSettings): KeyBuilder<C>;
}

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

export const DEFAULT_KEYSPACE_APP = 'tropis';

const SEGMENT_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^v[1-9][0-9]*$/;

/**
 * Common abbreviations rejected in `name`, so key names stay readable in
 * dashboards and incident notes (`user-preference`, not `usr-pref`).
 */
const ABBREVIATIONS = new Set([
  'cfg',
  'conf',
  'usr',
  'msg',
  'msgs',
  'tmp',
  'ctx',
  'req',
  'res',
  'resp',
  'idx',
  'cnt',
  'num',
  'str',
  'obj',
  'val',
  'mgr',
  'svc',
  'pref',
  'prefs',
  'perm',
  'perms',
  'pwd',
]);

function assertSegment(label: string, value: string): void {
  if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value)) {
    throw new InvalidKeyError(
      `Key ${label} ${JSON.stringify(value)} must be lowercase kebab-case ([a-z][a-z0-9]* joined by '-')`,
    );
  }
}

function assertName(name: string): void {
  assertSegment('name', name);
  const abbreviation = name.split('-').find((word) => ABBREVIATIONS.has(word));
  if (abbreviation) {
    throw new InvalidKeyError(
      `Key name ${JSON.stringify(name)} uses the abbreviation '${abbreviation}'; spell the word out`,
    );
  }
}

/** Percent-escapes an id so it cannot contain `:` or SCAN glob characters. */
export function escapeKeyId(id: KeyId): string {
  const raw = String(id);
  if (raw.length === 0) throw new InvalidKeyError('Key id must not be empty');
  return encodeURIComponent(raw).replace(
    /[!'()*~.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** App/env from process.env, read at build time so config loading order does not matter. */
export function resolveKeyspaceSettings(
  env: NodeJS.ProcessEnv = process.env,
): KeyspaceSettings {
  return {
    app: env.KEYSPACE_APP || DEFAULT_KEYSPACE_APP,
    env: env.KEYSPACE_ENV || env.NODE_ENV || 'development',
  };
}

function build<C extends KeyCapability>(
  spec: KeySpec<C>,
  settings: KeyspaceSettings,
  scope: string,
  ids: KeyId[],
): Key<C> {
  assertSegment('app', settings.app);
  assertSegment('env', settings.env);
  const segments = [
    settings.app,
    settings.env,
    scope,
    spec.capability,
    spec.module,
    spec.name,
    spec.version,
    ...ids.map(escapeKeyId),
  ];
  return segments.join(':') as Key<C>;
}

function makeBuilder<C extends KeyCapability>(
  spec: KeySpec<C>,
  settings: () => KeyspaceSettings,
): KeyBuilder<C> {
  return {
    spec,
    forTenant(tenantId: TenantId, ...ids: KeyId[]): Key<C> {
      if (!isTenantId(tenantId)) throw new InvalidTenantIdError(tenantId);
      return build(spec, settings(), `t.${escapeKeyId(tenantId)}`, ids);
    },
    global(...ids: KeyId[]): Key<C> {
      return build(spec, settings(), 'global', ids);
    },
    withKeyspace(explicit: KeyspaceSettings): KeyBuilder<C> {
      assertSegment('app', explicit.app);
      assertSegment('env', explicit.env);
      const fixed = { ...explicit };
      return makeBuilder(spec, () => fixed);
    },
  };
}

/**
 * Declares a key family. Call once in a module's constants/ and reuse the
 * builder; the spec is validated here so a bad definition fails at import.
 *
 * @example
 *   export const USER_PROFILE_CACHE = defineKey({
 *     capability: 'cache', module: 'user', name: 'profile', version: 'v1',
 *   });
 *   cache.set(USER_PROFILE_CACHE.forTenant(tenantId, userId), profile, 300);
 */
export function defineKey<C extends KeyCapability>(
  spec: KeySpec<C>,
): KeyBuilder<C> {
  if (!KEY_CAPABILITIES.includes(spec.capability)) {
    throw new InvalidKeyError(
      `Unknown key capability ${JSON.stringify(spec.capability)}`,
    );
  }
  assertSegment('module', spec.module);
  assertName(spec.name);
  if (!VERSION_PATTERN.test(spec.version)) {
    throw new InvalidKeyError(
      `Key version ${JSON.stringify(spec.version)} must look like v1, v2, ...`,
    );
  }
  const frozen = Object.freeze({ ...spec });
  return makeBuilder(frozen, () => resolveKeyspaceSettings());
}
