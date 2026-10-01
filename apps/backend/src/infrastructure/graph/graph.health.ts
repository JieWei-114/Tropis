import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { GRAPH, type GraphPort } from './graph.port';

@Injectable()
export class GraphHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(GRAPH) graph: GraphPort) {
    super('graph', graph);
  }
}
