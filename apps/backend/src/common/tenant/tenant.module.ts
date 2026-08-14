import { Module, Global } from '@nestjs/common';
import { TenantContext } from './tenant.context';

@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class TenantModule {}
