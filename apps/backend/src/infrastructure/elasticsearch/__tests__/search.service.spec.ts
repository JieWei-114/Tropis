import { Test } from '@nestjs/testing';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { SearchService } from '../search.service';

const mockEs = {
  info: jest.fn(),
  indices: { exists: jest.fn(), create: jest.fn(), delete: jest.fn() },
  index: jest.fn(),
  bulk: jest.fn(),
  search: jest.fn(),
  delete: jest.fn(),
  ping: jest.fn(),
};

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: ElasticsearchService, useValue: mockEs },
      ],
    }).compile();
    service = module.get(SearchService);
    jest.clearAllMocks();
  });

  it('logs success on init when ES is reachable', async () => {
    mockEs.info.mockResolvedValue({ cluster_name: 'test' });
    await service.onModuleInit();
    expect(mockEs.info).toHaveBeenCalled();
  });

  it('warns (does not throw) when ES is unreachable on init', async () => {
    mockEs.info.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('creates index if it does not exist', async () => {
    mockEs.indices.exists.mockResolvedValue(false);
    mockEs.indices.create.mockResolvedValue({});
    await service.ensureIndex('test-index');
    expect(mockEs.indices.create).toHaveBeenCalledWith({
      index: 'test-index',
      body: { mappings: undefined },
    });
  });

  it('skips create if index already exists', async () => {
    mockEs.indices.exists.mockResolvedValue(true);
    await service.ensureIndex('test-index');
    expect(mockEs.indices.create).not.toHaveBeenCalled();
  });

  it('indexes a single document', async () => {
    mockEs.index.mockResolvedValue({});
    await service.index('users', { id: '1', name: 'Alice' });
    expect(mockEs.index).toHaveBeenCalledWith({
      index: 'users',
      id: '1',
      document: { id: '1', name: 'Alice' },
    });
  });

  it('returns empty array on bulkIndex with no docs', async () => {
    await service.bulkIndex('users', []);
    expect(mockEs.bulk).not.toHaveBeenCalled();
  });

  it('returns hits and total from search', async () => {
    mockEs.search.mockResolvedValue({
      hits: {
        hits: [{ _source: { id: '1', name: 'Alice' } }],
        total: { value: 1 },
      },
    });
    const result = await service.search('users', { match_all: {} });
    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
  });
});
