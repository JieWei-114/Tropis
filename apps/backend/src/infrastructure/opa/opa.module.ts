import { Module, Global } from '@nestjs/common';
import { OpaService } from './opa.service';

@Global()
@Module({
  providers: [OpaService],
  exports: [OpaService],
})
export class OpaModule {}
