import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Code, ConnectError } from '@connectrpc/connect';
import { AppError } from '../../../common/errors';
import { CapabilityDisabledError } from '../../capability';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../../../gen/google/rpc/error_details_pb';
import { errorMessage, mapRpcError, toConnectError } from '../rpc-errors';

const info = (err: ConnectError) => err.findDetails(ErrorInfoSchema)[0];

describe('toConnectError', () => {
  it('passes a ConnectError through, adding ErrorInfo for its code', () => {
    const err = new ConnectError('nope', Code.PermissionDenied);
    const mapped = toConnectError(err);
    expect(mapped).toBe(err);
    expect(mapped.rawMessage).toBe('nope');
    expect(info(mapped)).toMatchObject({
      reason: 'FORBIDDEN',
      domain: 'tropis',
    });
  });

  it('keeps an ErrorInfo a handler already attached', () => {
    const err = new ConnectError('gone', Code.NotFound, undefined, [
      {
        desc: ErrorInfoSchema,
        value: { reason: 'USER_NOT_FOUND', domain: 'tropis' },
      },
    ]);
    const mapped = toConnectError(err);
    expect(mapped.findDetails(ErrorInfoSchema)).toHaveLength(1);
    expect(info(mapped)?.reason).toBe('USER_NOT_FOUND');
  });

  it.each([
    [new BadRequestException('bad'), Code.InvalidArgument],
    [new NotFoundException('missing'), Code.NotFound],
    [new ConflictException('dup'), Code.AlreadyExists],
    [new HttpException('slow down', 429), Code.ResourceExhausted],
    [new HttpException('teapot', 418), Code.InvalidArgument],
    [new HttpException('broken', 500), Code.Internal],
  ])('maps %p to the matching status code', (err, code) => {
    expect(toConnectError(err).code).toBe(code);
  });

  it('carries the thrower-supplied machine code as ErrorInfo, not a message prefix', () => {
    const err = toConnectError(
      new ConflictException({
        code: 'USER_ALREADY_EXISTS',
        message: 'A user with this email already exists',
      }),
    );
    expect(err.code).toBe(Code.AlreadyExists);
    expect(err.rawMessage).toBe('A user with this email already exists');
    expect(info(err)).toMatchObject({
      reason: 'USER_ALREADY_EXISTS',
      domain: 'tropis',
      metadata: { retryable: 'false' },
    });
  });

  it('reads a bare catalog code passed as the exception message', () => {
    const err = toConnectError(new NotFoundException('USER_NOT_FOUND'));
    expect(err.code).toBe(Code.NotFound);
    expect(err.rawMessage).toBe('The user was not found.');
    expect(info(err)?.reason).toBe('USER_NOT_FOUND');
  });

  it('uses the catalog rpc code of an AppError, with its metadata', () => {
    const err = toConnectError(
      new AppError('USER_LAST_ADMIN', { metadata: { tenant: 'acme' } }),
    );
    expect(err.code).toBe(Code.FailedPrecondition);
    expect(err.rawMessage).toBe(
      'The last admin of a tenant cannot be removed.',
    );
    expect(info(err)?.metadata).toEqual({ tenant: 'acme', retryable: 'false' });
  });

  it('marks retryable codes in ErrorInfo metadata', () => {
    const err = toConnectError(new AppError('SERVICE_UNAVAILABLE'));
    expect(err.code).toBe(Code.Unavailable);
    expect(info(err)?.metadata.retryable).toBe('true');
  });

  it('maps a disabled capability to Unimplemented, not retryable', () => {
    const err = toConnectError(new CapabilityDisabledError('graph', 'read'));
    expect(err.code).toBe(Code.Unimplemented);
    expect(info(err)).toMatchObject({
      reason: 'CAPABILITY_DISABLED',
      metadata: { retryable: 'false' },
    });
  });

  it('turns validation message arrays into google.rpc.BadRequest', () => {
    const err = toConnectError(
      new BadRequestException({
        message: ['email must be an email', 'property extra should not exist'],
      }),
    );
    expect(err.code).toBe(Code.InvalidArgument);
    expect(err.rawMessage).toBe('One or more fields are invalid.');
    expect(info(err)?.reason).toBe('VALIDATION_FAILED');
    expect(err.findDetails(BadRequestSchema)[0].fieldViolations).toEqual([
      expect.objectContaining({
        field: 'email',
        description: 'email must be an email',
      }),
      expect.objectContaining({
        field: 'extra',
        description: 'property extra should not exist',
      }),
    ]);
  });

  it('maps anything else to INTERNAL without leaking its message', () => {
    const mapped = mapRpcError(new Error('mongo down at 10.0.0.5'));
    expect(mapped.unexpected).toBe(true);
    expect(mapped.error).toMatchObject({
      code: Code.Internal,
      rawMessage: 'An internal error occurred.',
    });
    expect(info(mapped.error)?.reason).toBe('INTERNAL');
    expect(mapped.error.cause).toBeInstanceOf(Error);
    expect(toConnectError('weird').rawMessage).toBe(
      'An internal error occurred.',
    );
  });

  it('uses the same numeric codes as gRPC', () => {
    expect(Code.Unauthenticated).toBe(16);
    expect(Code.PermissionDenied).toBe(7);
    expect(Code.ResourceExhausted).toBe(8);
  });
});

describe('errorMessage', () => {
  it('strips the code prefix ConnectError adds to .message', () => {
    const err = new ConnectError('Invalid credentials', Code.Unauthenticated);
    expect(err.message).not.toBe('Invalid credentials');
    expect(errorMessage(err)).toBe('Invalid credentials');
  });

  it('reads plain errors and other values', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage(42)).toBe('42');
  });
});
