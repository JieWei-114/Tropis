import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrackBatchDto } from '../dto/track-event.dto';
import { TRACKING_MAX_BATCH } from '../constants/tracking.constants';

const validEvent = () => ({
  eventId: 'evt-1',
  eventName: 'button_click',
  anonymousId: 'anon-1',
  sessionId: 'sess-1',
  page: '/users',
  timestamp: 1735689600000,
  props: { label: 'Create User' },
});

async function validateBatch(body: unknown) {
  return validate(plainToInstance(TrackBatchDto, body));
}

describe('TrackBatchDto validation', () => {
  it('accepts a valid batch', async () => {
    const errors = await validateBatch({ events: [validEvent()] });
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty batch', async () => {
    const errors = await validateBatch({ events: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it(`rejects batches larger than ${TRACKING_MAX_BATCH}`, async () => {
    const errors = await validateBatch({
      events: Array.from({ length: TRACKING_MAX_BATCH + 1 }, validEvent),
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects events missing required fields', async () => {
    const { eventName: _dropped, ...rest } = validEvent();
    const errors = await validateBatch({ events: [rest] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric timestamp', async () => {
    const errors = await validateBatch({
      events: [{ ...validEvent(), timestamp: 'yesterday' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects oversized string fields', async () => {
    const errors = await validateBatch({
      events: [{ ...validEvent(), page: 'x'.repeat(2000) }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
