import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type {
  MessagingAdapter,
  MessageSubscription,
} from '../../messaging.port';

/**
 * publish/subscribe throw CapabilityDisabledError. close() resolves: it is a
 * shutdown hook with nothing to release, and failing shutdown would hide the
 * real reason a process stopped.
 */
export class DisabledMessagingAdapter implements MessagingAdapter {
  publish(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('messaging', 'publish'));
  }

  subscribe(): Promise<MessageSubscription> {
    return Promise.reject(
      new CapabilityDisabledError('messaging', 'subscribe'),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
