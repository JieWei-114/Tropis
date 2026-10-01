import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { KV, type KvPort } from './kv.port';

@Injectable()
export class KvHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(KV) kv: KvPort) {
    super('kv', kv);
  }
}
