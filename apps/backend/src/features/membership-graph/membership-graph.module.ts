import { Module } from '@nestjs/common';
import { GraphModule } from '../../infrastructure/graph/graph.module';
import { MembershipGraphService } from './services/membership-graph.service';

/**
 * Tenant membership and invitation chains projected from user events into
 * the graph capability. Import this wherever the graph is queried; the
 * projection is MembershipGraphWorkerModule (worker role).
 */
@Module({
  imports: [GraphModule.forRoot()],
  providers: [MembershipGraphService],
  exports: [MembershipGraphService],
})
export class MembershipGraphModule {}
