/**
 * 401 and 403 are different errors.
 *
 * A 401 is "the key is wrong" (AuthenticationError). A 403 is "the key is fine
 * and this is not allowed" (PermissionDeniedError and its subclasses). Mapped
 * by code first, then by status, so a 403 code the SDK does not know is still
 * a PermissionDeniedError, never an AuthenticationError.
 */
import * as root from '../../src';
import {
  AccessLevelInsufficientError,
  AgentKeyOutOfScopeError,
  AgentWorkspaceForbiddenError,
  AuthenticationError,
  CollectionProtectedError,
  PermissionDeniedError,
  QuotaExceededError,
  createErrorFromResponse,
} from '../../src/exceptions';

function body(code: string, fields: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} (prose)`, ...fields } };
}

const CASES: Array<
  [string, Record<string, unknown>, new (...args: never[]) => Error, object]
> = [
  [
    'a level too low',
    body('AGENT_ACCESS_LEVEL_INSUFFICIENT', {
      workspace: 'alpha',
      level: 'read',
      required_level: 'read_write',
    }),
    AccessLevelInsufficientError,
    { workspace: 'alpha', level: 'read', requiredLevel: 'read_write' },
  ],
  [
    'a level too low, workspace by id',
    body('AGENT_ACCESS_LEVEL_INSUFFICIENT', {
      workspace: null,
      level: 'read_write',
      required_level: 'full',
    }),
    AccessLevelInsufficientError,
    { workspace: null, level: 'read_write', requiredLevel: 'full' },
  ],
  [
    'a protected collection',
    body('COLLECTION_PROTECTED', { collection_name: 'invoices' }),
    CollectionProtectedError,
    { collectionName: 'invoices' },
  ],
  [
    'a workspace the agent was not granted',
    body('AGENT_KEY_WORKSPACE_FORBIDDEN', { workspace: 'beta' }),
    AgentWorkspaceForbiddenError,
    { workspace: 'beta' },
  ],
  [
    'an account-only route',
    body('AUTH_AGENT_KEY_OUT_OF_SCOPE', {
      agent_id: 'agent-1',
      required_scope: null,
    }),
    AgentKeyOutOfScopeError,
    { agentId: 'agent-1', requiredScope: null },
  ],
  [
    'a code the SDK does not know',
    body('SOME_FUTURE_REFUSAL', { extra: 1 }),
    PermissionDeniedError,
    {},
  ],
  [
    'a body without a code',
    { message: 'Forbidden' },
    PermissionDeniedError,
    {},
  ],
];

describe('a 403 maps by code, then by status', () => {
  it.each(CASES)('%s', (_name, payload, cls, fields) => {
    const error = createErrorFromResponse(
      payload,
      403,
      'Forbidden',
      'req-1'
    ) as PermissionDeniedError;
    expect(error.constructor).toBe(cls);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(403);
    expect(error.requestId).toBe('req-1');
    expect(error).toMatchObject(fields);
  });

  it.each(CASES.slice(0, 6))(
    '%s keeps the code and the whole body',
    (_name, payload) => {
      const error = createErrorFromResponse(payload, 403, 'Forbidden');
      const sent = payload.error as Record<string, unknown>;
      expect(error.code).toBe(sent.code);
      for (const [key, value] of Object.entries(sent)) {
        expect(error.details?.[key]).toEqual(value);
      }
    }
  );

  it('a body without a code keeps its message', () => {
    const error = createErrorFromResponse(
      { message: 'Forbidden' },
      403,
      'Forbidden'
    );
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('Forbidden');
  });
});

describe('a 401 is the authentication error, and only a 401', () => {
  it('maps to AuthenticationError', () => {
    const error = createErrorFromResponse(
      body('AUTH_INVALID_KEY'),
      401,
      'Unauthorized'
    );
    expect(error.constructor).toBe(AuthenticationError);
    expect(error).not.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('the family', () => {
  it('the specific refusals extend PermissionDeniedError', () => {
    for (const cls of [
      AccessLevelInsufficientError,
      CollectionProtectedError,
      AgentWorkspaceForbiddenError,
      AgentKeyOutOfScopeError,
    ]) {
      expect(cls.prototype).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('QuotaExceededError stays outside it', () => {
    const error = createErrorFromResponse(
      body('PLAN_LIMIT_EXCEEDED', {
        limit: 'max_collections',
        allowed: 3,
        current: 3,
      }),
      403,
      'Forbidden'
    );
    expect(error.constructor).toBe(QuotaExceededError);
    expect(error).not.toBeInstanceOf(PermissionDeniedError);
  });

  it('every class is exported from the package root under its name', () => {
    for (const name of [
      'PermissionDeniedError',
      'AccessLevelInsufficientError',
      'CollectionProtectedError',
      'AgentWorkspaceForbiddenError',
      'AgentKeyOutOfScopeError',
      'QuotaExceededError',
      'InvalidFilterError',
      'InvalidRequestFieldError',
    ]) {
      expect(typeof (root as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('serializes the fields of each class', () => {
    const level = createErrorFromResponse(CASES[0][1], 403, 'Forbidden');
    expect(level.toJSON()).toMatchObject({
      name: 'AccessLevelInsufficientError',
      workspace: 'alpha',
      level: 'read',
      requiredLevel: 'read_write',
    });
  });
});
