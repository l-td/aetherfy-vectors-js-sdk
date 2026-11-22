/**
 * Messages between running agents: send, receive, the history, restarted() and
 * parent(). What each call SENDS is read from the fetch mock, and what the
 * control plane answers is queued on it, in the shapes its routes answer with
 * (POST /deployments/{id}/messages, POST .../messages/receive, GET
 * .../messages). The local wait on the supervisor goes through the same fetch,
 * at AETHERFY_SUPERVISOR_WAIT_URL. The Python helper's tests/agent/
 * test_messages.py holds the same behaviour, case for case.
 */

import {
  messages,
  parent,
  receive,
  restarted,
  send,
  serviceRun,
} from '../../../src/agent';
import {
  AgentTransportError,
  MailboxFull,
  MessageError,
  MessageRateLimited,
  MessageStorageFull,
  MessageTooLarge,
  NotRunningOnAgent,
  RecipientEnded,
  RunAccessDenied,
  RunNotFound,
  SenderEnded,
} from '../../../src/agent/errors';

const API = 'https://agents.aetherfy.com/api/v1';
const OWN = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'http://127.0.0.1:9400';

const realFetch = global.fetch;
let fetchMock: jest.Mock;

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Answer each request with the next reply, in order. */
function queue(...replies: Response[]): void {
  for (const r of replies) fetchMock.mockResolvedValueOnce(r);
}

function stored(seq: number, senderRunId: string | null = PARENT) {
  return {
    id: `m-${seq}`,
    seq,
    sender: senderRunId ? 'run' : 'person',
    sender_run_id: senderRunId,
    body: { n: seq },
    created_at: '2026-11-18T12:00:00Z',
  };
}

function bodyOf(index: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
}

/** The wait id each receive request named, in order. */
function receiveWaitIds(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/messages/receive'))
    .map(([, init]) => JSON.parse(init.body).wait_id);
}

beforeEach(() => {
  process.env.AETHERFY_API_URL = API;
  process.env.AETHERFY_API_KEY = 'afy_test_run_key';
  // The mailbox is found through AETHERFY_DEPLOYMENT_ID alone: the run on a task
  // machine, the release on a service's. AETHERFY_SPAWN_ID names a run only, so
  // it is absent here, as on a service's machine.
  process.env.AETHERFY_DEPLOYMENT_ID = OWN;
  delete process.env.AETHERFY_SPAWN_ID;
  process.env.AETHERFY_SUPERVISOR_WAIT_URL = LOCAL;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  // Leave the run's mailbox with nothing pending for the next test: one check
  // acknowledges whatever this test handed over.
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(reply(200, { waiting: false }));
  await receive({ timeoutSeconds: 0 }).catch(() => undefined);
  global.fetch = realFetch;
});

describe('send()', () => {
  it('posts the message with an id of its own', async () => {
    queue(
      reply(201, {
        message: { id: 'x', seq: 3 },
        recipient: { id: PARENT, agent: 'boss', state: 'awaiting_message' },
      })
    );
    const sent = await send(PARENT, { progress: 0.5 });
    const [url, init] = fetchMock.mock.calls[0];
    expect([init.method, url]).toEqual([
      'POST',
      `${API}/deployments/${PARENT}/messages`,
    ]);
    const body = bodyOf(0);
    expect(body.body).toEqual({ progress: 0.5 });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent).toMatchObject({
      message_id: 'x',
      seq: 3,
      recipient_id: PARENT,
      recipient_agent: 'boss',
      recipient_state: 'awaiting_message',
    });
  });

  it('keeps an id it is given', async () => {
    queue(
      reply(200, { message: { id: 'mine', seq: 1 }, recipient: { id: PARENT } })
    );
    await send(PARENT, 'hello', { id: 'mine' });
    expect(bodyOf(0).id).toBe('mine');
  });

  it.each([
    [413, 'RUN_MESSAGE_TOO_LARGE', MessageTooLarge],
    [429, 'RUN_MESSAGE_RATE_LIMITED', MessageRateLimited],
    [429, 'RUN_MAILBOX_FULL', MailboxFull],
    [429, 'RUN_MESSAGE_STORAGE_FULL', MessageStorageFull],
    [409, 'RUN_MESSAGE_RECIPIENT_ENDED', RecipientEnded],
    [404, 'DEPLOYMENT_NOT_FOUND', RunNotFound],
    [403, 'AUTH_AGENT_KEY_OUT_OF_SCOPE', RunAccessDenied],
    [409, 'SOMETHING_NEW', MessageError],
  ])('a %s %s raises its own class', async (status, code, type) => {
    queue(reply(status, { detail: { code, message: 'no' } }));
    const error = await send(PARENT, 'hello').catch(e => e);
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
  });

  it('says when to send again after a rate limit', async () => {
    queue(
      reply(
        429,
        { detail: { code: 'RUN_MESSAGE_RATE_LIMITED', message: 'slow down' } },
        { 'Retry-After': '12' }
      )
    );
    const error = await send(PARENT, 'hello').catch(e => e);
    expect(error).toBeInstanceOf(MessageRateLimited);
    expect(error.retryAfter).toBe(12);
  });
});

describe('receive()', () => {
  it('hands over the oldest unread and acknowledges it on the NEXT call', async () => {
    queue(
      reply(200, { message: stored(1) }),
      reply(200, { message: stored(2) })
    );
    const first = await receive();
    const second = await receive();
    expect(first).toMatchObject({
      kind: 'message',
      seq: 1,
      body: { n: 1 },
      sender_run_id: PARENT,
    });
    expect(second).toMatchObject({ seq: 2 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API}/deployments/${OWN}/messages/receive`
    );
    expect(bodyOf(0).ack).toEqual([]);
    expect(bodyOf(1).ack).toEqual(['m-1']);
  });

  it('keeps an acknowledgement pending when the next call fails', async () => {
    queue(
      reply(200, { message: stored(1) }),
      reply(503, { detail: { code: 'SERVICE_UNAVAILABLE', message: 'x' } }),
      reply(200, { waiting: false })
    );
    await receive();
    await expect(receive({ timeoutSeconds: 0 })).rejects.toBeInstanceOf(
      MessageError
    );
    await receive({ timeoutSeconds: 0 });
    expect(bodyOf(2).ack).toEqual(['m-1']);
  });

  it('checks once with timeoutSeconds 0 and waits for nothing', async () => {
    queue(reply(200, { waiting: false }));
    expect(await receive({ timeoutSeconds: 0 })).toBeNull();
    expect(bodyOf(0).timeout_seconds).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks on the supervisor's LOCAL call, with no timeout, then asks once more", async () => {
    queue(
      reply(200, { waiting: true, wait_id: 'w-1' }),
      reply(200, { released: 'message' }),
      reply(200, { message: stored(4) })
    );
    const got = await receive();
    expect(got).toMatchObject({ seq: 4 });
    const [url, init] = fetchMock.mock.calls[1];
    expect([init.method, url]).toEqual(['POST', `${LOCAL}/wait`]);
    expect(JSON.parse(init.body)).toEqual({ wait_id: 'w-1' });
    expect(init.signal).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer afy_test_run_key');
  });

  it('returns null when the wait is released by its deadline', async () => {
    queue(
      reply(200, { waiting: true, wait_id: 'w-2' }),
      reply(200, { released: 'timeout' })
    );
    expect(await receive({ timeoutSeconds: 30 })).toBeNull();
    expect(bodyOf(0).timeout_seconds).toBe(30);
  });

  it("hands over a child's end, acknowledged by the child's run id", async () => {
    queue(
      reply(200, { ended: { run_id: CHILD, state: 'completed' } }),
      reply(200, { waiting: false })
    );
    expect(await receive()).toMatchObject({
      kind: 'ended',
      run_id: CHILD,
      state: 'completed',
    });
    await receive({ timeoutSeconds: 0 });
    expect(bodyOf(1).ack).toEqual([CHILD]);
  });

  it('sends fromRun, and raises SenderEnded when that run has ended', async () => {
    queue(
      reply(409, {
        detail: {
          code: 'RUN_MESSAGE_SENDER_ENDED',
          message: 'ended',
          sender_state: 'failed',
        },
      })
    );
    const error = await receive({ fromRun: CHILD }).catch(e => e);
    expect(bodyOf(0).from_run).toBe(CHILD);
    expect(error).toBeInstanceOf(SenderEnded);
    expect(error.senderState).toBe('failed');
  });

  it.each([[undefined], [30]])(
    "without the supervisor's wait, a wait (timeout %s) is refused before any request",
    async timeoutSeconds => {
      // The request would record the wait and put the run to sleep after the
      // grace, under a process that is not waiting.
      delete process.env.AETHERFY_SUPERVISOR_WAIT_URL;
      await expect(receive({ timeoutSeconds })).rejects.toBeInstanceOf(
        NotRunningOnAgent
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("without the supervisor's wait, a check still works", async () => {
    delete process.env.AETHERFY_SUPERVISOR_WAIT_URL;
    queue(reply(200, { waiting: false }));
    expect(await receive({ timeoutSeconds: 0 })).toBeNull();
  });

  it("a service reads its release's mailbox, with no spawn id", async () => {
    // A service's machine: AETHERFY_DEPLOYMENT_ID is the release it serves.
    const release = '44444444-4444-4444-8444-444444444444';
    process.env.AETHERFY_DEPLOYMENT_ID = release;
    queue(reply(200, { message: stored(1, CHILD) }));
    const got = await receive({ timeoutSeconds: 0, fromRun: CHILD });
    expect(got && got.kind === 'message' ? got.sender_run_id : null).toBe(
      CHILD
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${API}/deployments/${release}/messages/receive`
    );
  });

  it.each([
    [
      'receive',
      async () => {
        await receive({ timeoutSeconds: 0 });
      },
    ],
    [
      'messages',
      async () => {
        for await (const m of messages()) void m;
      },
    ],
  ])(
    '%s never reads the mailbox from AETHERFY_SPAWN_ID',
    async (_name, call) => {
      // One source: with AETHERFY_DEPLOYMENT_ID missing, a spawn id does not stand in for it.
      delete process.env.AETHERFY_DEPLOYMENT_ID;
      process.env.AETHERFY_SPAWN_ID = OWN;
      const error = await Promise.resolve()
        .then(call)
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(NotRunningOnAgent);
      expect((error as NotRunningOnAgent).variable).toBe(
        'AETHERFY_DEPLOYMENT_ID'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('a wait whose request failed is named again by the next call', async () => {
    // The request may have arrived and recorded the wait: a fresh id would be
    // refused while that one is outstanding.
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    queue(reply(200, { waiting: false }));
    await expect(receive()).rejects.toBeInstanceOf(AgentTransportError);
    await receive({ timeoutSeconds: 0 });
    const ids = receiveWaitIds();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('a wait whose local call failed is named again by the next call', async () => {
    queue(
      reply(200, { waiting: true, wait_id: 'w-9' }),
      reply(503, {}),
      reply(200, { waiting: false })
    );
    await expect(receive()).rejects.toBeInstanceOf(MessageError);
    await receive({ timeoutSeconds: 0 });
    const [first, second] = receiveWaitIds();
    expect(second).toBe(first);
  });

  it('after an answer the next call names a new wait', async () => {
    queue(
      reply(409, {
        detail: { code: 'RUN_RECEIVE_ALREADY_WAITING', message: 'x' },
      }),
      reply(200, { waiting: true, wait_id: 'w-1' }),
      reply(200, { released: 'timeout' }),
      reply(200, { waiting: false })
    );
    await expect(receive()).rejects.toBeInstanceOf(MessageError);
    expect(await receive({ timeoutSeconds: 5 })).toBeNull();
    await receive({ timeoutSeconds: 0 });
    expect(new Set(receiveWaitIds()).size).toBe(3);
  });

  it('runs one receive() at a time per run', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(r => {
          release = r;
        })
    );
    queue(reply(200, { message: stored(2) }));
    const first = receive();
    const second = receive();
    await new Promise(r => setTimeout(r, 0));
    // The second has not been sent while the first is open.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(reply(200, { message: stored(1) }));
    expect(await first).toMatchObject({ seq: 1 });
    expect(await second).toMatchObject({ seq: 2 });
    expect(bodyOf(1).ack).toEqual(['m-1']);
  });
});

describe('the history, restarted() and parent()', () => {
  it('reads the history page by page, in order', async () => {
    queue(
      reply(200, { messages: [stored(1), stored(2)], next_after: 2 }),
      reply(200, { messages: [stored(3)], next_after: null })
    );
    const seen: number[] = [];
    for await (const m of messages()) seen.push(m.seq);
    expect(seen).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API}/deployments/${OWN}/messages?after=0`
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${API}/deployments/${OWN}/messages?after=2`
    );
  });

  it.each([
    [1, false],
    [2, true],
    [undefined, false],
  ])('restarted() with attempt %s is %s', async (attempt, expected) => {
    queue(
      reply(200, {
        id: OWN,
        agent_id: 'a',
        state: 'active',
        ...(attempt === undefined ? {} : { attempt }),
      })
    );
    expect(await restarted()).toBe(expected);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/deployments/${OWN}`);
  });

  it('parent() is the run that started this one', async () => {
    queue(
      reply(200, {
        id: OWN,
        state: 'active',
        spawned_by_deployment_id: PARENT,
      }),
      reply(200, { id: OWN, state: 'active', spawned_by_deployment_id: null })
    );
    expect(await parent()).toBe(PARENT);
    expect(await parent()).toBeNull();
  });
});

describe('a service run', () => {
  it("sends and receives with the run's key and id", async () => {
    const handle = serviceRun({
      'X-Aetherfy-Run': CHILD,
      'X-Aetherfy-Run-Key': 'afy_test_service_run_key',
    });
    queue(
      reply(201, { message: { id: 'x', seq: 1 }, recipient: { id: PARENT } }),
      reply(200, { message: stored(1) })
    );
    await handle.send(PARENT, 'hi');
    await handle.receive();
    expect(
      fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)
    ).toEqual([
      'Bearer afy_test_service_run_key',
      'Bearer afy_test_service_run_key',
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${API}/deployments/${CHILD}/messages/receive`
    );
    // Its own mailbox's acknowledgement, kept apart from the task run's.
    queue(reply(200, { waiting: false }));
    await handle.receive({ timeoutSeconds: 0 });
  });
});

describe('the machine a wait is held on', () => {
  afterEach(() => {
    delete process.env.AETHERFY_INSTANCE_ID;
  });

  it('names the machine its supervisor set', async () => {
    // A service release's wait is held by the machine that runs the handler: the control plane is told which.
    process.env.AETHERFY_INSTANCE_ID = '8f1c2d3e-0000-4000-8000-00000000abcd';
    queue(reply(200, { waiting: false }));
    await receive({ timeoutSeconds: 0 });
    expect(bodyOf(0).instance_id).toBe('8f1c2d3e-0000-4000-8000-00000000abcd');
  });

  it('names none without it', async () => {
    delete process.env.AETHERFY_INSTANCE_ID;
    queue(reply(200, { waiting: false }));
    await receive({ timeoutSeconds: 0 });
    expect(bodyOf(0)).not.toHaveProperty('instance_id');
  });
});
