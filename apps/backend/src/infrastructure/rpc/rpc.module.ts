import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthzModule } from '../../common/authz/authz.module';
import { RpcAuthzService } from './rpc-authz.service';
import { RpcServer } from './rpc-server.service';

/**
 * RPC transport. Feature modules register their `*.rpc.controller.ts`
 * classes as ordinary providers, decorated with @RpcService; RpcServer
 * discovers them through Nest DI. A module whose handlers read the caller
 * imports forRoot() for RpcAuthzService; the role roots that open a
 * listener import it for RpcServer. One instance per process.
 */
@Module({})
export class RpcModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (RpcModule.root ??= {
      module: RpcModule,
      imports: [DiscoveryModule, AuditModule, AuthzModule],
      providers: [RpcAuthzService, RpcServer],
      exports: [RpcAuthzService, RpcServer],
    });
  }
}
