/**
 * An agent's key refused a workspace it was not granted arrives as a typed
 * error that names the workspace and how to grant access -- through the one
 * status/code mapping every error goes through (createErrorFromResponse).
 * The Python SDK's twin: tests/test_agent_workspace_forbidden.py.
 *
 * The body is the vector API's (vectordb services/agentAccess.js decideScope).
 */
import {
  AetherfyVectorsError,
  AgentWorkspaceForbiddenError,
  AuthenticationError,
  ServiceUnavailableError,
} from '../../src';
import { createErrorFromResponse } from '../../src/exceptions';

const forbidden = (workspace: string | null) => ({
  error: {
    code: 'AGENT_KEY_WORKSPACE_FORBIDDEN',
    message: "This agent's key cannot use ...",
    workspace,
    documentation_url: 'https://docs.aetherfy.com/platform/api-keys',
  },
});

describe('AGENT_KEY_WORKSPACE_FORBIDDEN', () => {
  it('is typed and names the workspace and how to grant it', () => {
    const err = createErrorFromResponse(forbidden('beta'), 403, 'Forbidden');
    expect(err).toBeInstanceOf(AgentWorkspaceForbiddenError);
    expect(err).toBeInstanceOf(AetherfyVectorsError);
    expect((err as AgentWorkspaceForbiddenError).workspace).toBe('beta');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('AGENT_KEY_WORKSPACE_FORBIDDEN');
    expect(err.message).toContain("workspace 'beta'");
    expect(err.message).toContain('afy access <agent> --add beta');
  });

  it('names the workspaceless collections too', () => {
    const err = createErrorFromResponse(forbidden(null), 403, 'Forbidden');
    expect(err).toBeInstanceOf(AgentWorkspaceForbiddenError);
    expect((err as AgentWorkspaceForbiddenError).workspace).toBeNull();
    expect(err.message).toContain('the collections in no workspace');
    expect(err.message).toContain('--add ""');
  });

  it('CONTROL: another 403 is still the authentication error it was', () => {
    const err = createErrorFromResponse(
      {
        error: {
          code: 'AUTH_AGENT_KEY_OUT_OF_SCOPE',
          message: 'no',
          agent_id: 'a',
        },
      },
      403,
      'Forbidden'
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).not.toBeInstanceOf(AgentWorkspaceForbiddenError);
    expect(err.code).toBe('AUTH_AGENT_KEY_OUT_OF_SCOPE');
  });

  it('an unreadable allowed set is the retryable 503', () => {
    const err = createErrorFromResponse(
      { error: { code: 'AGENT_ACCESS_UNAVAILABLE', message: 'Retry.' } },
      503,
      'Service Unavailable'
    );
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('AGENT_ACCESS_UNAVAILABLE');
  });

  it.each([400, 404, 409])(
    'CONTROL: the code under status %i is not this error',
    status => {
      expect(
        createErrorFromResponse(forbidden('beta'), status, 'x')
      ).not.toBeInstanceOf(AgentWorkspaceForbiddenError);
    }
  );

  it('serialises its workspace', () => {
    const err = createErrorFromResponse(
      forbidden('beta'),
      403,
      'Forbidden'
    ) as AgentWorkspaceForbiddenError;
    expect(err.toJSON()).toMatchObject({
      name: 'AgentWorkspaceForbiddenError',
      workspace: 'beta',
    });
  });
});
