import { afterEach, describe, expect, it, vi } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { createApi } from '../api';
import {
  FindAllRequestSchema,
  UpdateUserRequestSchema,
  UserResponseSchema,
  UsersResponseSchema,
} from '../gen/user/v1/user_pb';
import { RecentResponseSchema } from '../gen/analytics/v1/analytics_pb';

const proto = (bytes: Uint8Array) =>
  new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': 'application/proto' },
  });

async function bodyOf(init: RequestInit | undefined): Promise<Uint8Array> {
  return new Uint8Array(await new Response(init?.body).arrayBuffer());
}

const api = () =>
  createApi({ rpcBaseUrl: 'http://rpc.test', restBaseUrl: 'http://api.test' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api pagination', () => {
  it('pages users with page_size and page_token, not page and limit', async () => {
    const fetchMock = vi.fn(async () =>
      proto(
        toBinary(
          UsersResponseSchema,
          create(UsersResponseSchema, {
            users: [{ id: 'u1', name: 'A', email: 'a@b.co' }],
            nextPageToken: 'next',
            totalSize: 3,
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await api().listUsers({ pageSize: 1, pageToken: 'tok' });

    expect(page.nextPageToken).toBe('next');
    expect(page.totalSize).toBe(3);
    expect(page.users.map((u) => u.id)).toEqual(['u1']);
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const req = fromBinary(FindAllRequestSchema, await bodyOf(calls[0]![1]));
    expect(req).toMatchObject({
      pageSize: 1,
      pageToken: 'tok',
      page: 0,
      limit: 0,
    });
  });

  it('sends the current password on update', async () => {
    const fetchMock = vi.fn(async () =>
      proto(
        toBinary(UserResponseSchema, create(UserResponseSchema, { id: 'u1' })),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api().patchUser('u1', {
      password: 'new-pass-1',
      currentPassword: 'old',
    });

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const req = fromBinary(UpdateUserRequestSchema, await bodyOf(calls[0]![1]));
    expect(req.currentPassword).toBe('old');
  });
});

describe('api timestamps', () => {
  it('prefers the Timestamp field over the deprecated epoch-ms one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        proto(
          toBinary(
            RecentResponseSchema,
            create(RecentResponseSchema, {
              events: [
                {
                  eventId: 'a',
                  timestamp: 1n,
                  eventTime: timestampFromMs(2000),
                },
                { eventId: 'b', timestamp: 3000n },
              ],
            }),
          ),
        ),
      ),
    );
    const events = await api().fetchRecent();
    expect(events.map((e) => e.timestamp)).toEqual([2000, 3000]);
  });
});
