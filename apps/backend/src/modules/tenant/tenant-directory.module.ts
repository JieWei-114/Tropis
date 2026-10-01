import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TENANT_DIRECTORY } from '../../common/tenant/tenant-directory.port';
import { CacheModule } from '../../infrastructure/cache/cache.module';
import { DocumentsModule } from '../../infrastructure/documents/documents.module';
import { Tenant, TenantSchema } from './schemas/tenant.schema';
import { TenantRepository } from './repositories/tenant.repository';
import { TenantDirectoryService } from './services/tenant-directory.service';

/** Provides TENANT_DIRECTORY (the tenant registry) to the modules that import it. */
@Module({
  imports: [
    DocumentsModule.forRoot(),
    CacheModule.forRoot(),
    MongooseModule.forFeature([{ name: Tenant.name, schema: TenantSchema }]),
  ],
  providers: [
    TenantRepository,
    TenantDirectoryService,
    { provide: TENANT_DIRECTORY, useExisting: TenantDirectoryService },
  ],
  exports: [TENANT_DIRECTORY],
})
export class TenantDirectoryModule {}
