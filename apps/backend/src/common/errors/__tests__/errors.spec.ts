import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ERROR_CATALOG } from '@tropis/shared';
import {
  AppError,
  fieldViolationsFromMessages,
  fieldViolationsFromValidationErrors,
  normalizeError,
  pathOf,
  toProblemDetails,
  validationExceptionFactory,
} from '..';

describe('AppError', () => {
  it('takes status, retryability and message from the catalog', () => {
    const err = new AppError('USER_NOT_FOUND');
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.getStatus()).toBe(404);
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('The user was not found.');
    expect(err.getResponse()).toEqual({
      code: 'USER_NOT_FOUND',
      message: 'The user was not found.',
    });
  });

  it('keeps detail, violations, metadata and cause', () => {
    const cause = new Error('db');
    const err = new AppError('VALIDATION_FAILED', {
      detail: 'Check the form.',
      fieldViolations: [{ field: 'email', description: 'is invalid' }],
      metadata: { form: 'signup' },
      cause,
    });
    expect(err.message).toBe('Check the form.');
    expect(err.cause).toBe(cause);
    expect(normalizeError(err)).toMatchObject({
      code: 'VALIDATION_FAILED',
      httpStatus: 400,
      detail: 'Check the form.',
      fieldViolations: [{ field: 'email', description: 'is invalid' }],
      metadata: { form: 'signup' },
      unexpected: false,
      cause,
    });
  });

  it('builds a validation error', () => {
    expect(AppError.validation([{ field: 'a', description: 'b' }]).code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('normalizeError (compatibility with HttpException)', () => {
  it('maps a bare-string catalog code to that code, not the status code', () => {
    const n = normalizeError(new NotFoundException('USER_NOT_FOUND'));
    expect(n.code).toBe('USER_NOT_FOUND');
    expect(n.httpStatus).toBe(404);
    expect(n.detail).toBeUndefined();
    expect(n.definition.publicMessage).toBe('The user was not found.');
  });

  it('keeps a known code carried in the response body', () => {
    const n = normalizeError(
      new ConflictException({
        code: 'USER_ALREADY_EXISTS',
        message: 'A user with this email already exists',
      }),
    );
    expect(n.code).toBe('USER_ALREADY_EXISTS');
    expect(n.detail).toBe('A user with this email already exists');
    expect(n.httpStatus).toBe(409);
  });

  it('ignores an unknown code in the body and falls back to the status', () => {
    const n = normalizeError(
      new ForbiddenException({ code: 'NOT_IN_CATALOG', message: 'no' }),
    );
    expect(n.code).toBe('FORBIDDEN');
    expect(n.detail).toBe('no');
  });

  it.each([
    [new BadRequestException(), 'BAD_REQUEST', 400],
    [new NotFoundException(), 'NOT_FOUND', 404],
    [new HttpException('slow down', 429), 'RATE_LIMITED', 429],
    [new HttpException('teapot', 418), 'BAD_REQUEST', 418],
    [new NotImplementedException(), 'NOT_IMPLEMENTED', 501],
  ])('maps %p by status', (err, code, status) => {
    const n = normalizeError(err);
    expect(n.code).toBe(code);
    expect(n.httpStatus).toBe(status);
  });

  it('drops Nest default messages as detail but keeps authored ones', () => {
    expect(normalizeError(new NotFoundException()).detail).toBeUndefined();
    expect(
      normalizeError(new BadRequestException('No file provided')).detail,
    ).toBe('No file provided');
    expect(normalizeError(new HttpException('slow down', 429)).detail).toBe(
      'slow down',
    );
  });

  it('turns ValidationPipe message lists into VALIDATION_FAILED violations', () => {
    const n = normalizeError(
      new BadRequestException({
        message: ['email must be an email', 'property extra should not exist'],
        error: 'Bad Request',
        statusCode: 400,
      }),
    );
    expect(n.code).toBe('VALIDATION_FAILED');
    expect(n.fieldViolations).toEqual([
      { field: 'email', description: 'email must be an email' },
      { field: 'extra', description: 'property extra should not exist' },
    ]);
  });

  it('reports a failed Terminus check with probe names and statuses only', () => {
    const n = normalizeError(
      new ServiceUnavailableException({
        status: 'error',
        info: { mongo: { status: 'up' } },
        error: {
          redis: {
            status: 'down',
            message: 'connect ECONNREFUSED 10.0.0.5:6379',
          },
        },
        details: {
          mongo: { status: 'up' },
          redis: {
            status: 'down',
            message: 'connect ECONNREFUSED 10.0.0.5:6379',
          },
        },
      }),
    );
    expect(n.code).toBe('HEALTH_CHECK_FAILED');
    expect(n.httpStatus).toBe(503);
    expect(n.checks).toEqual([
      { name: 'mongo', status: 'up' },
      { name: 'redis', status: 'down' },
    ]);
    expect(JSON.stringify(n.checks)).not.toContain('10.0.0.5');
    expect(n.detail).toBeUndefined();
  });
});

describe('normalizeError (other errors)', () => {
  it('never describes an unexpected error', () => {
    const cause = new Error('mongo down at 10.0.0.5');
    const n = normalizeError(cause);
    expect(n).toMatchObject({
      code: 'INTERNAL',
      httpStatus: 500,
      unexpected: true,
      cause,
    });
    expect(n.detail).toBeUndefined();
    expect(normalizeError('string').code).toBe('INTERNAL');
  });

  it('recognises shared infrastructure errors by name', () => {
    const disabled = Object.assign(new Error('Capability off'), {
      name: 'CapabilityDisabledError',
    });
    expect(normalizeError(disabled)).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      httpStatus: 501,
      unexpected: false,
    });
    const open = Object.assign(new Error('open'), {
      name: 'CircuitBreakerOpenError',
    });
    expect(normalizeError(open).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('maps body-parser client errors by status', () => {
    const parse = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    expect(normalizeError(parse)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'The request body is not valid JSON.',
      unexpected: false,
    });
    const big = Object.assign(new Error('too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    expect(normalizeError(big).code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validation helpers', () => {
  it('flattens nested class-validator errors with dotted paths', () => {
    const child = Object.assign(new ValidationError(), {
      property: 'city',
      constraints: { isNotEmpty: 'city should not be empty' },
    });
    const root = Object.assign(new ValidationError(), {
      property: 'address',
      children: [child],
    });
    const email = Object.assign(new ValidationError(), {
      property: 'email',
      constraints: { isEmail: 'email must be an email' },
    });
    expect(fieldViolationsFromValidationErrors([email, root])).toEqual([
      { field: 'email', description: 'email must be an email' },
      { field: 'address.city', description: 'city should not be empty' },
    ]);
    expect(validationExceptionFactory([email]).fieldViolations).toHaveLength(1);
  });

  it('parses flat messages best-effort', () => {
    expect(
      fieldViolationsFromMessages(['Not a sentence starting with field?']),
    ).toEqual([
      { field: 'Not', description: 'Not a sentence starting with field?' },
    ]);
    expect(fieldViolationsFromMessages(['!!'])).toEqual([
      { field: '', description: '!!' },
    ]);
  });
});

describe('toProblemDetails', () => {
  it('renders RFC 9457 members plus the extensions', () => {
    const problem = toProblemDetails(
      normalizeError(new NotFoundException('USER_NOT_FOUND')),
      { instance: '/api/users/42', traceId: 'abc' },
    );
    expect(problem).toEqual({
      type: 'https://errors.tropis.dev/user-not-found',
      title: ERROR_CATALOG.USER_NOT_FOUND.publicMessage,
      status: 404,
      instance: '/api/users/42',
      code: 'USER_NOT_FOUND',
      traceId: 'abc',
      retryable: false,
    });
  });

  it('strips the query string from the instance', () => {
    expect(pathOf('/api/files?key=secret')).toBe('/api/files');
    expect(pathOf(undefined)).toBe('/');
  });
});
