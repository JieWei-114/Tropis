import { timingSafeEqual } from 'crypto';
import { capabilityUp, type CapabilityHealth } from '../../../capability';
import {
  buildCanonicalString,
  computeSignature,
} from '../../signing.canonical';
import type { SignatureInput, SigningPort } from '../../signing.port';

/** Signs and verifies with Node's crypto in this process. */
export class InprocessSigningAdapter implements SigningPort {
  sign(input: SignatureInput, secret: string): Promise<string> {
    return Promise.resolve(computeSignature(secret, canonical(input)));
  }

  verify(
    input: SignatureInput,
    signature: string,
    secret: string,
  ): Promise<boolean> {
    const expected = Buffer.from(
      computeSignature(secret, canonical(input)),
      'utf8',
    );
    const given = Buffer.from(signature, 'utf8');
    return Promise.resolve(
      given.length === expected.length && timingSafeEqual(given, expected),
    );
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('inprocess'));
  }
}

function canonical(input: SignatureInput): string {
  return buildCanonicalString(
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.body,
  );
}
