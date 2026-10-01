import { DynamicModule, Module } from '@nestjs/common';
import { MongooseDocumentsModule } from './adapters/mongoose/mongoose-documents.module';
import { DocumentsHealthIndicator } from './documents.health';

/**
 * Provides DOCUMENTS (DocumentsPort) and the Mongoose root connection that
 * repositories use through MongooseModule.forFeature().
 */
@Module({})
export class DocumentsModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (DocumentsModule.root ??= {
      module: DocumentsModule,
      imports: [MongooseDocumentsModule],
      providers: [DocumentsHealthIndicator],
      exports: [MongooseDocumentsModule, DocumentsHealthIndicator],
    });
  }
}
