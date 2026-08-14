import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage.service';
import * as Minio from 'minio';

jest.mock('minio');

describe('StorageService', () => {
  let service: StorageService;
  let mockClient: jest.Mocked<Minio.Client>;

  beforeEach(async () => {
    mockClient = {
      bucketExists: jest.fn(),
      makeBucket: jest.fn(),
      putObject: jest.fn(),
      presignedGetObject: jest.fn(),
      removeObject: jest.fn(),
      listObjects: jest.fn(),
    } as any;

    (Minio.Client as jest.MockedClass<typeof Minio.Client>).mockImplementation(
      () => mockClient,
    );

    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, def: unknown) => def) },
        },
      ],
    }).compile();

    service = module.get(StorageService);
    jest.clearAllMocks();
  });

  it('creates default bucket on init if it does not exist', async () => {
    mockClient.bucketExists.mockResolvedValue(false);
    mockClient.makeBucket.mockResolvedValue(undefined);
    await service.onModuleInit();
    expect(mockClient.makeBucket).toHaveBeenCalled();
  });

  it('skips bucket creation if bucket already exists', async () => {
    mockClient.bucketExists.mockResolvedValue(true);
    await service.onModuleInit();
    expect(mockClient.makeBucket).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when MinIO is unreachable on init', async () => {
    mockClient.bucketExists.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('uploads an object and returns path', async () => {
    mockClient.putObject.mockResolvedValue({ etag: 'abc', versionId: null });
    const path = await service.upload(
      'file.png',
      Buffer.from('data'),
      4,
      'image/png',
    );
    expect(path).toContain('file.png');
  });
});
