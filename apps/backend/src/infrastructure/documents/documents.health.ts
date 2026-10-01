import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { DOCUMENTS, type DocumentsPort } from './documents.port';

@Injectable()
export class DocumentsHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(DOCUMENTS) documents: DocumentsPort) {
    super('documents', documents);
  }
}
