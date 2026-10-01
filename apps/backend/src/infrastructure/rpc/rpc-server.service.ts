import {
  Injectable,
  type BeforeApplicationShutdown,
  type Type,
} from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { DescMethod, DescService } from '@bufbuild/protobuf';
import {
  createConnectRouter,
  type ConnectRouter,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { AUDITED_KEY } from '../../common/audit/audited.decorator';
import { AuthorizationService } from '../../common/authz/authorization.service';
import {
  permissionOf,
  type Permission,
} from '../../common/authz/authorize.decorator';
import { createLogger } from '../../common/observability/logger';
import { RpcAuthzService } from './rpc-authz.service';
import { withCors, type RpcRequestHandler } from './rpc-cors';
import { RpcListener } from './rpc-listener';
import {
  RPC_SERVICE_KEY,
  RPC_TIERS,
  type RpcServiceMetadata,
  type RpcTier,
} from './rpc-service.decorator';
import { ReflectionIndex, REFLECTION_SERVICES } from './reflection';
import { StandardHealth } from './standard-health';
import { Health } from '../../gen/grpc/health/v1/health_pb';
import { correlationInterceptor } from './interceptors/correlation.interceptor';
import { metricsInterceptor } from './interceptors/metrics.interceptor';
import { errorsInterceptor } from './interceptors/errors.interceptor';
import { authenticationInterceptor } from './interceptors/authentication.interceptor';
import { tenantInterceptor } from './interceptors/tenant.interceptor';
import {
  auditInterceptor,
  type RpcAuditTarget,
} from './interceptors/audit.interceptor';
import { authorizationInterceptor } from './interceptors/authorization.interceptor';
import { validationInterceptor } from './interceptors/validation.interceptor';
import { RPC_VALIDATE_KEY } from './rpc-validate.decorator';

/** Largest request message accepted, the grpc-js default. */
const READ_MAX_BYTES = 4 * 1024 * 1024;

/** A listener starts only for the tiers given a port (the role decides). */
export interface RpcServerOptions {
  publicPort?: number;
  internalPort?: number;
  host?: string;
  /** Serve grpc.reflection on both listeners (config/grpc-reflection.ts). */
  reflection: boolean;
  /** Browser origins allowed to call the public listener. */
  corsOrigins: readonly string[];
}

export interface RpcServerAddresses {
  publicPort?: number;
  internalPort?: number;
}

interface RegisteredService {
  service: DescService;
  tiers: readonly RpcTier[];
  instance: object;
  className: string;
}

/** A service instance's method table, keyed by the generated `localName`. */
type MethodTable = Record<string, (...args: unknown[]) => unknown>;

/**
 * Serves every @RpcService provider over Connect, gRPC and gRPC-Web.
 *
 * Two listeners, one per tier: public services (and health) on the public
 * port, `internal` services (and health) on the internal port only, so which
 * tier an RPC belongs to is decided by which port routes it. Each call passes
 * through, outermost first: RED metrics, trace and correlation id, error
 * mapping, authentication, tenant scope, audit, authorization (@Authorize),
 * input validation (@RpcValidate), then the handler. A handler whose request
 * message has fields but declares no @RpcValidate stops the server from
 * starting, so no RPC takes unchecked input.
 */
@Injectable()
export class RpcServer implements BeforeApplicationShutdown {
  private readonly logger = createLogger('rpc');
  private readonly listeners: RpcListener[] = [];
  private readonly health: StandardHealth[] = [];
  private readonly auditTargets = new Map<DescMethod, RpcAuditTarget>();
  private readonly permissions = new Map<DescMethod, Permission>();
  private readonly validators = new Map<DescMethod, Type<object>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly authz: RpcAuthzService,
    private readonly auditLog: AuditLogService,
    private readonly authorization: AuthorizationService,
  ) {}

  async start(options: RpcServerOptions): Promise<RpcServerAddresses> {
    const services = this.discoverServices();
    for (const s of services) this.indexHandlers(s);

    const interceptors: Interceptor[] = [
      metricsInterceptor(),
      correlationInterceptor,
      errorsInterceptor,
      authenticationInterceptor(this.authz),
      tenantInterceptor(),
      auditInterceptor(this.auditLog, (m) => this.auditTargets.get(m)),
      authorizationInterceptor(this.authorization, (m) =>
        this.permissions.get(m),
      ),
      validationInterceptor((m) => this.validators.get(m)),
    ];

    const handlerFor = (tier: RpcTier): RpcRequestHandler => {
      const own = services.filter((s) => s.tiers.includes(tier));
      const descs = own.map((s) => s.service);
      const health = new StandardHealth(descs);
      this.health.push(health);
      const routes = (router: ConnectRouter) => {
        for (const s of own) router.service(s.service, bindMethods(s));
        health.register(router);
        if (options.reflection) {
          new ReflectionIndex([
            ...descs,
            Health,
            ...REFLECTION_SERVICES,
          ]).register(router);
        }
      };
      return connectNodeAdapter({
        routes,
        interceptors,
        readMaxBytes: READ_MAX_BYTES,
      }) as RpcRequestHandler;
    };

    const host = options.host ?? '0.0.0.0';
    const addresses: RpcServerAddresses = {};
    if (options.publicPort !== undefined) {
      const listener = new RpcListener(
        withCors(options.corsOrigins, handlerFor('public')),
      );
      this.listeners.push(listener);
      addresses.publicPort = await listener.listen(options.publicPort, host);
    }
    if (options.internalPort !== undefined) {
      const listener = new RpcListener(handlerFor('internal'));
      this.listeners.push(listener);
      addresses.internalPort = await listener.listen(
        options.internalPort,
        host,
      );
    }
    for (const s of services) {
      this.logger.info('service-registered', 'RPC service registered', {
        'rpc.service': s.service.typeName,
        'rpc.handler': s.className,
        'rpc.tiers': s.tiers.join(','),
      });
    }
    return addresses;
  }

  /**
   * Reports NOT_SERVING, then stops the listeners once calls drain. The role
   * bootstrap calls it on SIGTERM before any module is torn down;
   * beforeApplicationShutdown is the fallback for an app closed another way.
   * Safe to call twice.
   */
  async stop(): Promise<void> {
    for (const h of this.health) h.drain();
    await Promise.all(this.listeners.map((l) => l.close()));
    this.listeners.length = 0;
    this.health.length = 0;
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  private discoverServices(): RegisteredService[] {
    const found: RegisteredService[] = [];
    const seen = new Map<string, string>();
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || typeof metatype !== 'function') continue;
      const meta = this.reflector.get<RpcServiceMetadata | undefined>(
        RPC_SERVICE_KEY,
        metatype,
      );
      if (!meta) continue;
      for (const tier of meta.tiers) {
        if (!RPC_TIERS.includes(tier)) {
          throw new Error(`${metatype.name}: unknown RPC tier "${tier}"`);
        }
        const key = `${tier}:${meta.service.typeName}`;
        const other = seen.get(key);
        if (other && other !== metatype.name) {
          throw new Error(
            `${meta.service.typeName} is implemented by both ${other} and ${metatype.name}`,
          );
        }
        seen.set(key, metatype.name);
      }
      if (found.some((s) => s.instance === instance)) continue;
      found.push({
        service: meta.service,
        tiers: meta.tiers,
        instance: instance as object,
        className: metatype.name,
      });
    }
    return found;
  }

  private indexHandlers(s: RegisteredService): void {
    const table = s.instance as MethodTable;
    for (const method of s.service.methods) {
      const fn = table[method.localName];
      if (typeof fn !== 'function') continue;
      const permission = permissionOf(
        this.reflector,
        fn,
        s.instance.constructor,
      );
      if (permission) this.permissions.set(method, permission);
      const dto = this.reflector.get<Type<object> | undefined>(
        RPC_VALIDATE_KEY,
        fn,
      );
      if (dto) {
        this.validators.set(method, dto);
      } else if (method.input.fields.length > 0) {
        throw new Error(
          `${s.className}.${method.localName}: ${method.input.typeName} has fields but the handler declares no @RpcValidate`,
        );
      }
      this.auditTargets.set(method, {
        action: this.reflector.getAllAndOverride<string | undefined>(
          AUDITED_KEY,
          [fn, s.instance.constructor],
        ),
        resource: `${s.className}.${method.localName}`,
      });
    }
  }
}

/**
 * The implementation object Connect calls, with each method bound to the Nest
 * instance. Methods the class does not define answer UNIMPLEMENTED. The
 * signatures were checked where it matters, on the class itself
 * (`implements ServiceImpl<typeof Service>`), which the service descriptor
 * here no longer carries.
 */
function bindMethods(s: RegisteredService): Partial<ServiceImpl<DescService>> {
  const table = s.instance as MethodTable;
  const impl: MethodTable = {};
  for (const method of s.service.methods) {
    const fn = table[method.localName];
    if (typeof fn === 'function') impl[method.localName] = fn.bind(s.instance);
  }
  return impl as unknown as Partial<ServiceImpl<DescService>>;
}
