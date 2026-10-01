import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import mongoose from 'mongoose';
import { MongooseDocumentsAdapter } from '../../src/infrastructure/documents/adapters/mongoose/mongoose-documents.adapter';
import { describeDocumentsPort } from '../../src/infrastructure/documents/__tests__/documents.conformance';
import { describeWithDocker } from './docker';

jest.setTimeout(240_000);

describeWithDocker('Documents conformance (mongodb)')(
  'Documents conformance (mongodb)',
  () => {
    let mongo: StartedMongoDBContainer;

    beforeAll(async () => {
      mongo = await new MongoDBContainer('mongo:7').start();
    });

    afterAll(async () => {
      await mongo?.stop();
    });

    describeDocumentsPort('mongoose', {
      make: async () => {
        const connection = await mongoose
          .createConnection(mongo.getConnectionString(), {
            directConnection: true,
            dbName: 'conformance',
          })
          .asPromise();
        return {
          port: new MongooseDocumentsAdapter(connection),
          connection,
        };
      },
      teardown: async ({ connection }) => {
        await connection.close();
      },
    });
  },
);
