import { MongooseDocumentsAdapter } from '../adapters/mongoose/mongoose-documents.adapter';

describe('MongooseDocumentsAdapter', () => {
  it('reports up when the server answers ping', async () => {
    const command = jest.fn().mockResolvedValue({ ok: 1 });
    const adapter = new MongooseDocumentsAdapter({ db: { command } } as never);
    await expect(adapter.health()).resolves.toEqual({
      status: 'up',
      adapter: 'mongodb',
    });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('reports down before the connection is open', async () => {
    const adapter = new MongooseDocumentsAdapter({ db: undefined } as never);
    await expect(adapter.health()).resolves.toMatchObject({ status: 'down' });
  });
});
