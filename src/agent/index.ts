/**
 * Aetherfy Agent — what code running on an Aetherfy machine does.
 *
 * This is a THIN wrapper over contracts the platform already publishes. It
 * invents no protocol: every call here has a hand-rolled equivalent in
 * https://docs.aetherfy.com/agents/task-contract, and the helper exists so
 * that equivalent stops being copied into every task.
 *
 * ```javascript
 * const {
 *   payload, machine, fanOut, spawn, writeResult, result, wait, cancel,
 *   agentUrl, callAgent,
 * } = require('aetherfy-vectors/agent');
 *
 * const data = await payload();              // this run's input, {} when none
 * const shape = machine();                   // vcpus / memory_mb / region
 * const results = await fanOut(work, data.items ?? []);
 * await writeResult({ rows: results.length }); // this run's answer
 *
 * const run = await spawn('nightly-rollup', { date: '2026-09-08' });
 * const finished = await wait(run.spawn_id); // or result(...) for a plain read
 * console.log(finished.result);
 * await cancel(run.spawn_id); // stop it, waiting or running
 *
 * const url = await agentUrl('analyst');     // a peer service's address, by name
 * const reply = await callAgent('analyst', '/summarise', {
 *   method: 'POST',
 *   json: { id: 7 },
 * });
 * console.log(reply.status, reply.json());
 * ```
 *
 * TWO HALVES, and they are the same contract read from opposite ends. A task
 * reads its payload and writes its result; whoever started it spawns and then
 * reads that result back. `payload`/`writeResult` are files on the machine and
 * touch no network at all; `spawn`/`result`/`wait`/`cancel` are the control
 * plane, and are the only calls here that do.
 *
 * A RUN HAS A LIFE BEFORE IT RUNS. When the account is at its in-flight limit, a
 * new run waits in the account's line (state `waiting`, no machine, nothing
 * billed), and `wait` keeps waiting through that time. A run ends `completed`,
 * `failed` or `cancelled`; `cancel` is what ends one from outside, whether it is
 * waiting or executing.
 *
 * INSIDE A SERVICE'S RUN HANDLER, USE THE HANDLE. The key these module-level
 * calls read from `AETHERFY_API_KEY` is, in a service, the release's: right for
 * the service's own traffic, wrong for a run. `serviceRun(req.headers)` returns
 * a handle whose `spawn`, `result`, `wait` and `cancel` use the run's own key,
 * so what the handler starts belongs to the run.
 *
 * A THIRD THING, for a service that talks to another service: `agentUrl` and
 * `agentUrls` look a peer's public address up BY NAME at call time, and
 * `callAgent` makes the request. Nothing about a peer's address is baked into
 * this machine's environment, so a peer that is recreated is found at its new
 * address without a restart here. The lookup is the control plane's, and its
 * answer is remembered in this process for `PEER_CACHE_SECONDS`.
 *
 * It ships inside the `aetherfy-vectors` package as the `aetherfy-vectors/agent`
 * subpath, and the standard runtime image preinstalls that package — so on a
 * plain agent these names import with nothing in your package.json. A custom
 * container installs it itself.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  AGENT_NOT_FOUND,
  AGENT_NOT_REACHABLE,
  AGENT_RUN_LINE_FULL,
  AUTH_AGENT_KEY_OUT_OF_SCOPE,
  AgentError,
  AgentTransportError,
  DEPLOYMENT_ACCESS_DENIED,
  DEPLOYMENT_NOT_A_RUN,
  DEPLOYMENT_NOT_FOUND,
  DEPLOYMENT_WAIT_TIMEOUT_INVALID,
  NotARun,
  NotAServiceRun,
  NotRunningOnAgent,
  PEER_HAS_NO_URL,
  PayloadTooLarge,
  PayloadUnavailable,
  PeerHasNoUrl,
  PeerLookupError,
  PeerNotFound,
  RUN_ID_HEADER,
  RUN_KEY_HEADER,
  RUN_PAYLOAD_TOO_LARGE,
  ResultTooLarge,
  RunAccessDenied,
  RunCancelError,
  RunLineFull,
  RunNotFound,
  RunReadError,
  SpawnError,
  WaitTimeoutInvalid,
} from './errors';
import {
  DEFAULT_TIMEOUT_MS,
  PeerAttempt,
  requestJson,
  requestPeer,
  USER_AGENT_PREFIX,
} from './http';
import { Cancellation, MachineShape, PeerResponse, Run, Spawn } from './models';
import {
  PEER_CACHE_SECONDS,
  PEER_RETRY_CAP_SECONDS,
  PEER_RETRY_FLOOR_SECONDS,
  peerCache,
  retryDelay,
} from './peers';
import type { PeerWait } from './peers';
import { assertAllowedOptionKeys, optionKeys } from '../utils/options';
import { SDK_VERSION } from '../version';

export {
  AgentError,
  AgentTransportError,
  NotARun,
  NotAServiceRun,
  NotRunningOnAgent,
  PayloadTooLarge,
  PayloadUnavailable,
  PeerHasNoUrl,
  PeerLookupError,
  PeerNotFound,
  ResultTooLarge,
  RunAccessDenied,
  RunCancelError,
  RunLineFull,
  RunNotFound,
  RunReadError,
  SpawnError,
  WaitTimeoutInvalid,
};
export type { Cancellation, MachineShape, PeerResponse, Run, Spawn };

/**
 * How long a looked-up peer address is served without asking again. The one
 * definition lives beside the cache that applies it; this is the same number,
 * readable where the calls are, and in both languages.
 */
export { PEER_CACHE_SECONDS, PEER_RETRY_CAP_SECONDS, PEER_RETRY_FLOOR_SECONDS };

/**
 * The release this helper announces in its User-Agent. NOT a literal of its
 * own: it is the package's one version constant, so this cannot name a release
 * that never shipped. Pinned against package.json by
 * `tests/unit/agent/packaging.test.ts`.
 */
export const AGENT_HELPER_VERSION = SDK_VERSION;

/**
 * The one line a fan-out prints, and the reason it prints at all: the platform
 * cannot count the customer's in-machine workers for them. It lands in the
 * run's logs like any other stdout, so a run's width is visible after the fact
 * without the customer having written the line. BYTE-FOR-BYTE identical to the
 * Python helper's, and asserted as such in both suites.
 */
function fanOutLine(
  width: number,
  vcpus: number,
  memoryMb: number,
  n: number
): string {
  return `aetherfy: fanning out ${width} wide on ${vcpus} vCPU / ${memoryMb} MB (${n} tasks)`;
}

/**
 * Multiplier behind the default fan-out width. Model calls and HTTP requests
 * spend nearly all their time waiting, so a pool wider than the core count is
 * the right default for them.
 */
const IO_BOUND_WIDTH_PER_VCPU = 8;

/**
 * How far past the server's own hold this helper lets a {@link wait} request
 * run before it gives up on the socket. THE CLIENT'S BOUND MUST EXCEED THE
 * SERVER'S, or a wait that the control plane is about to answer at its deadline
 * is cut off here first and reported as a transport failure — the one outcome a
 * caller cannot tell from a real network fault. The margin covers the round trip
 * and the serialization on either side.
 */
const WAIT_TRANSPORT_MARGIN_SECONDS = 15;

/**
 * The bound the control plane enforces on `?timeout_seconds`. Checked here too,
 * so a caller learns about a bad argument without paying a round trip to be
 * told. Waiting longer than the maximum is another call, not a bigger number:
 * the request is held open and anything longer is cut by the network in front
 * of Aetherfy.
 */
export const WAIT_TIMEOUT_MIN_SECONDS = 1;
export const WAIT_TIMEOUT_MAX_SECONDS = 60;
export const WAIT_TIMEOUT_DEFAULT_SECONDS = 30;

function userAgent(): string {
  return `${USER_AGENT_PREFIX}${AGENT_HELPER_VERSION}`;
}

function requireEnv(
  variable: string,
  purpose: string,
  remedy?: string
): string {
  const value = process.env[variable];
  if (!value) throw new NotRunningOnAgent(variable, purpose, remedy);
  return value;
}

/**
 * What to say when the RESULT PATH is missing, instead of the default "the
 * platform sets this before your entrypoint starts" — which is not true of
 * this one variable. The task supervisor offers the path only when the machine
 * also carries an inline cap (image_generator.py: `if _RESULT_MAX_BYTES > 0`,
 * else it logs that this run cannot return a result), and a `service` machine
 * has no runs to return anything from. A customer told the platform always
 * sets it would go looking for a bug in their own code.
 */
const NO_RESULT_PATH_REMEDY =
  'writeResult() is a TASK-ONLY call: a result belongs to a run, and a ' +
  '`service` agent has no runs, so a service machine is never given a result ' +
  'path and this call can never succeed there. Return your answer over HTTP ' +
  "instead. On a `type: job` machine Aetherfy sets the path before each run's " +
  'entrypoint starts, but only when that machine also carries an inline result ' +
  'cap (AETHERFY_RUN_INLINE_MAX_BYTES) — without the cap the platform cannot ' +
  'accept a result and does not offer the path.';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The control plane's `{"detail": {...}}` envelope, pulled out of a body.
 *
 * NOT the vector API's `{"error": {...}}` — the agent control plane is a
 * different service with a different envelope, and conflating them is how a
 * caller ends up reading `undefined` for every code. A `detail` that is a bare
 * string is FastAPI's own default, produced by routes that never reached our
 * error handling; it carries prose but no code.
 */
function detailOf(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  if (!record) return {};
  const detail = record.detail;
  const nested = asRecord(detail);
  if (nested) return nested;
  if (typeof detail === 'string') return { message: detail };
  return {};
}

function numberOf(
  detail: Record<string, unknown>,
  key: string
): number | undefined {
  const value = detail[key];
  return typeof value === 'number' ? value : undefined;
}

function stringOrNull(
  detail: Record<string, unknown>,
  key: string
): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * Return this run's input payload, or `{}` when the run was given none.
 *
 * THE EMPTY CASE IS THE NORMAL CASE. A scheduled fire, or a manual run started
 * without input, gets `{}`. Write the task so that no input is the path it
 * takes most often and treat any input as an optional override.
 *
 * The payload is written to a file on the machine before the entrypoint starts
 * and its path put in `AETHERFY_SPAWN_PAYLOAD_PATH`; nothing crosses the
 * network to read it. When that variable is unset, or names a file that is not
 * there, the same bytes are fetched from
 * `GET {AETHERFY_API_URL}/deployments/{AETHERFY_SPAWN_ID}/payload` — a fallback
 * for a machine that could not write the file, not the path to build on.
 *
 * @throws {PayloadUnavailable} Neither route yielded a payload.
 */
export async function payload(): Promise<Record<string, unknown>> {
  const path = process.env.AETHERFY_SPAWN_PAYLOAD_PATH;
  if (path) {
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      // The file the platform promised is not readable. Fall through to the
      // HTTP route rather than failing: that is the case the fallback is for.
      raw = null;
    }
    if (raw !== null) {
      if (!raw.trim()) return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new PayloadUnavailable(
          `AETHERFY_SPAWN_PAYLOAD_PATH (${path}) does not hold JSON: ${reason}`
        );
      }
      return asRecord(parsed) ?? {};
    }
  }

  const apiUrl = process.env.AETHERFY_API_URL;
  const spawnId = process.env.AETHERFY_SPAWN_ID;
  const apiKey = process.env.AETHERFY_API_KEY;
  if (!apiUrl || !spawnId || !apiKey) {
    throw new PayloadUnavailable(
      'No payload file (AETHERFY_SPAWN_PAYLOAD_PATH) and no way to fetch one: ' +
        'AETHERFY_API_URL, AETHERFY_SPAWN_ID and AETHERFY_API_KEY must all be ' +
        'set for the HTTP fallback. All four are set by the platform on an ' +
        'agent machine.'
    );
  }

  // ENCODED, like every id this module puts in a path. Left raw, an id
  // holding a slash or a `..` silently becomes a request to a DIFFERENT
  // route — fetch normalises the path before it leaves — and the answer is
  // then parsed as though it were this one. A 404 is the honest outcome; a
  // wrong object read as the right one is not.
  const url = `${apiUrl.replace(/\/+$/, '')}/deployments/${encodeURIComponent(
    spawnId
  )}/payload`;
  const { status, body } = await requestJson('GET', url, {
    apiKey,
    userAgent: userAgent(),
    repeatable: true,
  });
  if (status !== 200) {
    const message = detailOf(body).message;
    throw new PayloadUnavailable(
      `The payload fallback (${url}) answered ${status}: ` +
        `${typeof message === 'string' ? message : 'no message'}`
    );
  }
  const record = asRecord(body);
  if (!record) {
    throw new PayloadUnavailable(
      `The payload fallback (${url}) answered 200 with a body that is not an object.`
    );
  }
  return asRecord(record.payload) ?? {};
}

/**
 * Return the shape of the machine this run is executing on.
 *
 * Numbers, not the strings the environment carries — the width of a pool is
 * arithmetic, and `'4' * 8` is a bug JavaScript will happily coerce its way
 * around rather than report.
 *
 * @throws {NotRunningOnAgent} A variable the platform always sets is missing.
 */
export function machine(): MachineShape {
  const vcpus = requireEnv('AETHERFY_VCPUS', "this machine's vCPU count");
  const memoryMb = requireEnv('AETHERFY_MEMORY_MB', "this machine's memory");
  const region = requireEnv('AETHERFY_REGION', "this machine's region");

  const parsedVcpus = Number(vcpus);
  const parsedMemory = Number(memoryMb);
  if (!Number.isInteger(parsedVcpus) || !Number.isInteger(parsedMemory)) {
    throw new AgentError(
      `AETHERFY_VCPUS (${vcpus}) and AETHERFY_MEMORY_MB (${memoryMb}) must ` +
        'both be whole numbers.'
    );
  }
  return { vcpus: parsedVcpus, memory_mb: parsedMemory, region };
}

export interface FanOutOptions {
  /** Defaults to `vcpus * 8`. */
  width?: number;
}

// Derived from the type by optionKeys(): see src/utils/options.ts.
const FAN_OUT_OPTION_KEYS = optionKeys<FanOutOptions>({ width: true });

/**
 * Run `fn` over `items` on an in-machine pool, results in INPUT order.
 *
 * Fanning out inside the machine is the cheap kind of parallelism on Aetherfy:
 * no extra machines, no cold starts, and no awake time beyond the run itself.
 * Spawning is for isolation and independent lifecycles — see {@link spawn}.
 *
 * `width` is promise concurrency, which is all I/O-bound work needs: model
 * calls and HTTP requests fan out on the event loop and never touch a thread.
 * CPU-bound work is the customer's own `worker_threads` problem, deliberately
 * — a pool this helper owned would have to serialize every argument and every
 * result, and would be slower than the loop for everything else it is used
 * for. The Python helper offers processes because Python has a GIL to escape.
 *
 * NO FAILURE IS SWALLOWED. If any call rejects, the rejection from the
 * LOWEST-INDEXED failing item is re-thrown once every worker has settled —
 * deterministic, rather than whichever promise happened to lose the race. Work
 * already in flight is not cancelled: a promise cannot be interrupted, and
 * pretending otherwise would leak half-finished work.
 *
 * Prints one line to stdout before running, so the run's logs record how wide
 * it went.
 */
export async function fanOut<T, R>(
  fn: (item: T) => R | Promise<R>,
  items: Iterable<T>,
  options: FanOutOptions = {}
): Promise<R[]> {
  assertAllowedOptionKeys(options, FAN_OUT_OPTION_KEYS, 'fanOut');
  const materialized = Array.from(items);
  const shape = machine();

  const width = Math.trunc(
    options.width ?? shape.vcpus * IO_BOUND_WIDTH_PER_VCPU
  );
  if (!Number.isFinite(width) || width < 1) {
    throw new AgentError(`width must be at least 1, not ${options.width}`);
  }

  // stdout IS the logging interface on an Aetherfy task: everything a run
  // prints becomes the run's logs, and this line is the whole reason fanOut
  // announces itself. console.warn would file it under stderr, which is where
  // failures go.
  // eslint-disable-next-line no-console
  console.log(
    fanOutLine(width, shape.vcpus, shape.memory_mb, materialized.length)
  );

  if (materialized.length === 0) return [];

  const results = new Array<R>(materialized.length);
  const failures = new Array<{ error: unknown } | undefined>(
    materialized.length
  );
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= materialized.length) return;
      try {
        results[index] = await fn(materialized[index]);
      } catch (error) {
        // Recorded, not thrown: throwing here would stop this worker and leave
        // the remaining items unattempted, which is a different contract.
        failures[index] = { error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(width, materialized.length) }, () => worker())
  );

  for (const failure of failures) {
    if (failure) throw failure.error;
  }
  return results;
}

/**
 * Ask the control plane to run another agent, and return once recorded.
 *
 * `child` is the id or name of an agent you own, of either type: a task's run
 * forks its command, a service's run is a request to its own
 * `POST /aetherfy/run`. The parent is this machine's own agent, recorded on the
 * run and never on the child. The child runs in this agent's region, and the two must
 * be connected by `spawn.workers` in `aetherfy.yaml` for the call to be
 * allowed.
 *
 * ACCEPTANCE IS NOT EXECUTION. The returned {@link Spawn} says the run was
 * recorded. A run over the account's in-flight limit is not refused: it WAITS in
 * the account's line (`status` `'waiting'`, `position` its place there, 1 being
 * next), with no machine and nothing billed, and starts when a slot frees;
 * otherwise `status` is `'queued'` and it goes straight to a machine.
 * {@link wait} includes the time in the line. A spawn is refused only when the
 * line itself is full ({@link RunLineFull}), and nothing is retried for you
 * then. Wait for the run and read its state.
 *
 * Keep the payload small: it is for parameters and references, not data. Pass
 * anything large by reference to a collection.
 *
 * This uses `AETHERFY_API_KEY`: on a task machine that is the run's own key, in
 * a service the release's. Inside a service's run handler, spawn through
 * {@link serviceRun} so the new run belongs to the run being handled.
 *
 * @throws {PayloadTooLarge} 413, the payload crossed the inline cap.
 * @throws {RunLineFull} 429, the account's line of waiting runs is full.
 * @throws {SpawnError} Any other refusal — read `code`, not the prose.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function spawn(
  child: string,
  spawnPayload?: Record<string, unknown>
): Promise<Spawn> {
  return spawnAs(
    environmentKey('the key a spawn authenticates with'),
    child,
    spawnPayload
  );
}

/**
 * The one spawn, for whichever key it is made with: {@link spawn} passes the
 * environment's, a {@link ServiceRun} its run's.
 */
async function spawnAs(
  apiKey: string,
  child: string,
  spawnPayload: Record<string, unknown> | undefined
): Promise<Spawn> {
  const url = spawnUrl();

  // THE SPAWN'S OWN ID, made once per call. The control plane stores it with
  // the run it makes and answers a repeat of the same id with that run, so a
  // spawn whose answer was lost on the way (a timeout after the request left)
  // is sent again safely and never makes a second run.
  const { status, body, retryAfter } = await requestJson('POST', url, {
    apiKey,
    userAgent: userAgent(),
    body: {
      child_agent_id: child,
      payload: spawnPayload ?? {},
      request_id: randomUUID(),
    },
    repeatable: true,
  });

  if (status === 200 || status === 201 || status === 202) {
    const record = asRecord(body);
    if (!record) {
      throw new SpawnError(
        `The spawn was accepted with ${status} but the body was not an ` +
          'object, so the run cannot be identified.',
        { status }
      );
    }
    // A run waiting in the line has no job yet, and a run that is not waiting
    // has no place in it: null is an answer, not the string "null".
    return {
      spawn_id: stringOf(record.spawn_id),
      job_id:
        record.job_id === null || record.job_id === undefined
          ? null
          : stringOf(record.job_id),
      child_agent_id: stringOf(record.child_agent_id),
      region: stringOf(record.region),
      status: stringOf(record.status),
      workspace: stringOf(record.workspace),
      estimated_start:
        typeof record.estimated_start === 'string'
          ? record.estimated_start
          : undefined,
      position: Number.isInteger(record.position)
        ? (record.position as number)
        : null,
      raw: record,
    };
  }

  const detail = detailOf(body);
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : `Spawning '${child}' failed with status ${status}.`;
  const code = typeof detail.code === 'string' ? detail.code : undefined;

  // THE CODE DECIDES, NOT THE STATUS ALONE. A status is a category the platform
  // reuses; the code is the thing it promises not to rename. Mapping on 413
  // alone would stamp RUN_PAYLOAD_TOO_LARGE onto the next unrelated 413 the
  // control plane grows, and the caller would branch on a lie it could not see
  // through — the typed error carries the wrong code AND the right message. An
  // unrecognised pairing falls through to SpawnError, which reports exactly
  // what arrived.
  if (status === 413 && code === RUN_PAYLOAD_TOO_LARGE) {
    throw new PayloadTooLarge(message, {
      payloadBytes: numberOf(detail, 'payload_bytes'),
      maxBytes: numberOf(detail, 'max_bytes'),
      detail,
    });
  }
  if (status === 429 && code === AGENT_RUN_LINE_FULL) {
    throw new RunLineFull(message, {
      waitingCount: numberOf(detail, 'waiting_count'),
      maxWaitingRuns: numberOf(detail, 'max_waiting_runs'),
      inFlightCount: numberOf(detail, 'in_flight_count'),
      maxInFlightRuns: numberOf(detail, 'max_in_flight_runs'),
      limit: stringOrNull(detail, 'limit'),
      detail,
      retryAfter,
    });
  }
  throw new SpawnError(message, { status, code, detail, retryAfter });
}

/**
 * Return `value` to whoever started this run.
 *
 * The mirror of {@link payload}: Aetherfy puts the path of a file in
 * `AETHERFY_SPAWN_RESULT_PATH` before the entrypoint starts, and stores what
 * was written there once the process ends. Nothing crosses the network, and
 * there is no call to make — a parent reads it back from the run itself with
 * {@link result} or {@link wait}.
 *
 * RETURNING NOTHING IS THE NORMAL CASE, so most tasks never call this. A run
 * that writes no file is recorded as returning nothing, which is not the same
 * as failing to return something. Passing `null` or `undefined` records the
 * same thing: the platform reads a literal `null` as "returned nothing", and an
 * empty column already says that.
 *
 * The result is for answers and references, not data — it shares the payload's
 * inline cap, one number bounding both directions. Anything larger belongs in a
 * collection in your Aetherfy vector database, with its id in the result.
 *
 * THE LAST CALL WINS. The file is overwritten, so calling this twice returns
 * the second value; there is no accumulation and no merge.
 *
 * Non-finite numbers become `null`, which is `JSON.stringify`'s own rule and
 * the reason nothing here has to police them: what lands on disk is always
 * valid JSON. The Python helper has to refuse them explicitly, because its
 * `json` writes bare `NaN` tokens instead.
 *
 * @throws {ResultTooLarge} The encoded result crosses this machine's cap. The
 *   platform would have dropped it and recorded `result_error` instead — this
 *   refuses at the write so the caller can shrink it.
 * @throws {NotRunningOnAgent} `AETHERFY_SPAWN_RESULT_PATH` is not set, so there
 *   is nowhere to put an answer.
 * @throws {TypeError} `value` cannot be serialized — a cycle, or a BigInt.
 */
export async function writeResult(value: unknown): Promise<void> {
  // DELIBERATELY NOT THE DOCS' HAND-ROLLED VERSION, which no-ops when the
  // variable is missing. That is the right shape inline in a customer's own
  // script, where the author can see the fallback; it is the wrong shape for a
  // library, which would be silently discarding the one value it was called to
  // deliver. The variable is absent only on a machine that has no result path
  // to offer — off Aetherfy entirely, or a task machine whose supervisor could
  // not prepare the file — and in both cases a run that thinks it answered did
  // not.
  const path = requireEnv(
    'AETHERFY_SPAWN_RESULT_PATH',
    'the path this run writes its answer to',
    NO_RESULT_PATH_REMEDY
  );

  // `undefined` at the top level makes JSON.stringify return undefined rather
  // than a string. Recorded as `null`, which is what the platform reads as
  // "returned nothing" — the same thing the Python helper writes for None.
  const json = JSON.stringify(value) ?? 'null';
  // ONE encode, measured and written. Encoding twice is how a size check ends
  // up describing bytes other than the ones that land on disk, and the
  // supervisor compares BYTE lengths (`len(raw) > cap`) over the file it reads
  // back in binary.
  const encoded = new TextEncoder().encode(json);

  const maxBytes = inlineMaxBytes();
  if (maxBytes !== null && encoded.length > maxBytes) {
    throw new ResultTooLarge(
      `This run's result is ${encoded.length} bytes and the inline cap is ` +
        `${maxBytes}. The result is for answers and references, not data: ` +
        'write the data to a collection and return its id.',
      { resultBytes: encoded.length, maxBytes }
    );
  }

  await writeFile(path, encoded);
}

/**
 * Read one run back, with whatever it returned.
 *
 * Answers immediately with the run as it stands. A run that has not ended has no
 * result yet: its `state` is `'waiting'` while it waits in the account's line and
 * `'active'` while it is executing, and it ends `'completed'`, `'failed'` or
 * `'cancelled'`. {@link wait} is the same read with the waiting done
 * server-side, and is what to use when the answer is the point.
 *
 * `runId` is a run's id — `Spawn.spawn_id` from a {@link spawn}, or the id of
 * this run itself in `AETHERFY_SPAWN_ID`.
 *
 * @throws {RunNotFound} 404, no run has that id.
 * @throws {RunAccessDenied} 403 `DEPLOYMENT_ACCESS_DENIED`, the run belongs to
 *   another account (an account key was used).
 * @throws {RunReadError} 403 `AUTH_AGENT_KEY_OUT_OF_SCOPE` when this machine's
 *   own `AETHERFY_API_KEY` reads a run that key may not read (which ones it
 *   may: https://docs.aetherfy.com/platform/api-keys#agent-scoped-keys-issued-by-aetherfy).
 * @throws {RunReadError} Any other refusal — read `code`, not the prose.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function result(runId: string): Promise<Run> {
  return resultAs(environmentKey('the key a run is read with'), runId);
}

async function resultAs(apiKey: string, runId: string): Promise<Run> {
  return readRun(runUrl(runId), apiKey);
}

/**
 * Hold one request open until the run finishes, then return it.
 *
 * The read side of the result path, and the reason a parent does not poll:
 * without it every caller writes the same loop with its own interval, and all
 * of them pay for the privilege of not knowing yet.
 *
 * THE TIME IN THE LINE IS PART OF WHAT IS WAITED FOR. A run over the account's
 * in-flight limit waits in the account's line (state `waiting`), and this keeps
 * holding through it. It returns when the run has ended: `completed`, `failed`
 * or `cancelled`.
 *
 * A TIMEOUT IS NOT AN ERROR. If the run has not finished in `timeoutSeconds`
 * this returns it exactly as it stands — read `Run.state`, which is `waiting`
 * while the run waits in the line, `active` while it is executing, and
 * `completed`, `failed` or `cancelled` when it is over, and call again. Waiting
 * longer than the maximum is a second call, not a bigger number: the request is
 * held open, and anything longer is cut by the network in front of Aetherfy.
 *
 * ONE CONNECTION FAILURE IS NOT RETRIED HERE, unlike every other call in this
 * module. A retry would silently hold a second full timeout and hand back a run
 * up to twice as late as the number the caller passed; the bound this
 * function's argument promises is worth more than the blip it would paper over.
 * Call again.
 *
 * @throws {AgentError} `timeoutSeconds` is outside the server's bound. The
 *   argument is wrong, and no request is sent.
 * @throws {WaitTimeoutInvalid} 422, the server rejected the timeout anyway —
 *   its bound moved and this helper's copy is stale.
 * @throws {RunNotFound} 404, no run has that id.
 * @throws {RunAccessDenied} 403 `DEPLOYMENT_ACCESS_DENIED`, the run belongs to
 *   another account (an account key was used).
 * @throws {RunReadError} 403 `AUTH_AGENT_KEY_OUT_OF_SCOPE` when this machine's
 *   own `AETHERFY_API_KEY` reads a run that key may not read (which ones it
 *   may: https://docs.aetherfy.com/platform/api-keys#agent-scoped-keys-issued-by-aetherfy).
 * @throws {RunReadError} Any other refusal.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function wait(
  runId: string,
  timeoutSeconds: number = WAIT_TIMEOUT_DEFAULT_SECONDS
): Promise<Run> {
  return waitAs(
    environmentKey('the key a run is read with'),
    runId,
    timeoutSeconds
  );
}

async function waitAs(
  apiKey: string,
  runId: string,
  timeoutSeconds: number
): Promise<Run> {
  const seconds = Math.trunc(timeoutSeconds);
  if (
    !Number.isFinite(seconds) ||
    seconds < WAIT_TIMEOUT_MIN_SECONDS ||
    seconds > WAIT_TIMEOUT_MAX_SECONDS
  ) {
    throw new AgentError(
      `timeoutSeconds must be between ${WAIT_TIMEOUT_MIN_SECONDS} and ` +
        `${WAIT_TIMEOUT_MAX_SECONDS}, not ${timeoutSeconds}. Waiting longer ` +
        'is another call to wait(), not a bigger number.'
    );
  }
  return readRun(`${runUrl(runId)}/wait?timeout_seconds=${seconds}`, apiKey, {
    timeoutMs: (seconds + WAIT_TRANSPORT_MARGIN_SECONDS) * 1000,
    repeatable: false,
  });
}

/**
 * Cancel a run, whether it is waiting in the account's line or executing.
 *
 * `runId` is a run's id — `Spawn.spawn_id` from a {@link spawn}. The answer is a
 * {@link Cancellation}: its `outcome` is `'cancelled'` (the run is cancelled
 * now), `'stopping'` (it was executing and is being stopped; it ends
 * `cancelled`) or `'already_finished'` (it had ended before this call). A run
 * that had already ended is NOT an error, so cancelling twice, or racing the
 * run's own end, needs no handling. `cancelled_count` counts every run this call
 * cancelled, the runs started below the cancelled one (its descendants)
 * included: a cancelled run's own spawns are cancelled with it.
 *
 * A run cancelled from outside ends `cancelled`, on every path: by a person, by
 * a run above it, or as part of a cascade. A cancelled run's key stops working
 * at once, so whatever it was still starting is refused.
 *
 * WHICH RUNS A KEY MAY CANCEL. An account's key may cancel any run of the
 * account. An agent's own key (`AETHERFY_API_KEY` on an agent machine) may
 * cancel only the runs below its own run, not the run itself and not its
 * siblings. Inside a service's run handler, cancel through {@link serviceRun}.
 *
 * This is for runs. A release (a deploy) is cancelled with the CLI's
 * `afy cancel <agent>`.
 *
 * @throws {RunNotFound} 404, no run has that id.
 * @throws {RunAccessDenied} 403, the run belongs to another account (`code`
 *   `DEPLOYMENT_ACCESS_DENIED`), or an agent's key was used on a run that is not
 *   below its own (`code` `AUTH_AGENT_KEY_OUT_OF_SCOPE`).
 * @throws {NotARun} 409 `DEPLOYMENT_NOT_A_RUN`, the id names a release.
 * @throws {RunCancelError} Any other refusal — read `code`, not the prose. Note
 *   that {@link RunNotFound} and {@link RunAccessDenied} are not its subclasses;
 *   catch {@link AgentError} to see all of them.
 * @throws {AgentError} `runId` is empty. No request is sent.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function cancel(runId: string): Promise<Cancellation> {
  return cancelAs(environmentKey('the key a cancel authenticates with'), runId);
}

async function cancelAs(apiKey: string, runId: string): Promise<Cancellation> {
  // REPEATABLE: a second cancel of the same run changes nothing (it answers
  // `stopping` with a count of 0, or `already_finished`), so a cancel whose
  // answer was lost is sent again rather than reported as maybe applied.
  const { status, body, retryAfter } = await requestJson(
    'POST',
    `${runUrl(runId)}/cancel`,
    { apiKey, userAgent: userAgent(), repeatable: true }
  );

  if (status === 200) {
    const record = asRecord(body);
    const run = asRecord(record?.run);
    const outcome = record?.outcome;
    if (!record || !run || typeof outcome !== 'string' || outcome === '') {
      throw new RunCancelError(
        'Cancelling the run answered 200 with a body that has no run and ' +
          'outcome, so what the cancel did is not known.',
        { status }
      );
    }
    return {
      run: runFrom(run),
      outcome,
      message: typeof record.message === 'string' ? record.message : '',
      cancelled_count: Number.isInteger(record.cancelled_count)
        ? (record.cancelled_count as number)
        : 0,
    };
  }

  const detail = detailOf(body);
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : `Cancelling the run failed with status ${status}.`;
  const code = typeof detail.code === 'string' ? detail.code : undefined;

  // THE CODE DECIDES, NOT THE STATUS ALONE, as in spawn() and the reads. The 404
  // and the DEPLOYMENT_ACCESS_DENIED 403 are the read family's own, shared with
  // it; the out-of-scope 403 is mapped here and not on a read, because a cancel
  // has one problem to report with it (this key may not cancel that run) and a
  // read has another.
  const refusal = sharedRunRefusal(status, code, message, detail);
  if (refusal) throw refusal;
  if (status === 403 && code === AUTH_AGENT_KEY_OUT_OF_SCOPE) {
    throw new RunAccessDenied(message, detail, AUTH_AGENT_KEY_OUT_OF_SCOPE);
  }
  if (status === 409 && code === DEPLOYMENT_NOT_A_RUN) {
    throw new NotARun(message, detail);
  }
  throw new RunCancelError(message, { status, code, detail, retryAfter });
}

/**
 * The headers of a request, as the runtimes hand them over: a fetch `Headers`
 * (or anything with a `get` that reads names without regard to case), Node's
 * `request.headers`, or a plain object. Names are compared without regard to
 * case in every shape.
 */
export type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

/**
 * The run a service is handling right now, as a handle to spawn, read, wait on
 * and cancel with THAT RUN'S OWN KEY. Built by {@link serviceRun}.
 *
 * `spawn`, `result`, `wait` and `cancel` are the module-level functions of the
 * same names, with the same signatures, the same endpoints, the same errors and
 * the same documentation; only the key differs. What the handler starts through
 * the handle belongs to the run: it is in the run's tree, so cancelling the run
 * cancels it, and the run's key may read and wait on it. `run_id` is the id of
 * the run being handled.
 *
 * WHY A HANDLE YOU PASS, NOT A CONTEXT THE LIBRARY KEEPS. A service answers many
 * runs at once in one process, so which run a call belongs to has to come from
 * somewhere. An implicit context (`AsyncLocalStorage`) is lost wherever work
 * leaves the async chain the handler started (a worker thread, or a callback a
 * pooling or batching library runs from its own queue): the call then falls
 * back, without an error, to the release's key, and what it starts lands
 * outside the run's tree, where cancelling the run does not reach it. An
 * explicit handle is either in scope or a visible `ReferenceError`.
 *
 * TWO KEYS IN ONE HANDLER. The module-level functions read `AETHERFY_API_KEY`,
 * which in a service is the release's: right for the service's own traffic,
 * wrong for a run. Do not mix them on one run. A run spawned through the handle
 * belongs to the run's tree and not to the release's, so a module-level
 * {@link wait} on it is refused (403 `AUTH_AGENT_KEY_OUT_OF_SCOPE`, a
 * {@link RunReadError}): wait through the handle.
 *
 * THE KEY LASTS AS LONG AS THE RUN. It stops working when the run ends,
 * answered, cancelled or failed, so do not keep the handle past the handler.
 * The handle holds the key in a closure and has no property that shows it, so
 * logging the handle logs no credential.
 */
export interface ServiceRun {
  /** The id of the run being handled (`X-Aetherfy-Run`). */
  readonly run_id: string;
  /** {@link spawn}, with this run's key: the new run belongs to this run. */
  spawn(child: string, spawnPayload?: Record<string, unknown>): Promise<Spawn>;
  /** {@link result}, with this run's key. */
  result(runId: string): Promise<Run>;
  /** {@link wait}, with this run's key. */
  wait(runId: string, timeoutSeconds?: number): Promise<Run>;
  /** {@link cancel}, with this run's key: it may cancel the runs below this run. */
  cancel(runId: string): Promise<Cancellation>;
}

/**
 * Return the handle for the run a service's `POST /aetherfy/run` is handling.
 *
 * Call it with the request's headers, at the top of the handler:
 *
 * ```javascript
 * app.post('/aetherfy/run', async (req, res) => {
 *   const run = serviceRun(req.headers);
 *   const child = await run.spawn('worker', { id: 7 });
 *   const finished = await run.wait(child.spawn_id);
 *   res.json({ answer: finished.result });
 * });
 * ```
 *
 * The platform sets `X-Aetherfy-Run` (the run's id) and `X-Aetherfy-Run-Key` (the
 * run's own key) on that one call, and removes both from every public request,
 * so a handler can trust them. They are read without regard to case, from any
 * {@link HeaderSource}: Node's `req.headers`, a fetch `Headers`, a plain object.
 * The key is never logged by this package.
 *
 * THE HANDLE IS EXPLICIT BECAUSE AN IMPLICIT ONE WOULD FAIL SILENTLY: see
 * {@link ServiceRun}. The module-level functions are unchanged and keep reading
 * `AETHERFY_API_KEY`, which on a task machine is the run's key and in a service
 * is the release's.
 *
 * @throws {NotAServiceRun} The headers carry no run id and run key. This is for
 *   the handler of `POST /aetherfy/run` only; a public request has neither.
 */
export function serviceRun(headers: HeaderSource): ServiceRun {
  const runId = headerValue(headers, RUN_ID_HEADER);
  const apiKey = headerValue(headers, RUN_KEY_HEADER);
  const missing = [
    ...(runId === undefined ? [RUN_ID_HEADER] : []),
    ...(apiKey === undefined ? [RUN_KEY_HEADER] : []),
  ];
  if (runId === undefined || apiKey === undefined) {
    throw new NotAServiceRun(missing);
  }
  return Object.freeze({
    run_id: runId,
    spawn: (child: string, spawnPayload?: Record<string, unknown>) =>
      spawnAs(apiKey, child, spawnPayload),
    result: (id: string) => resultAs(apiKey, id),
    wait: (id: string, timeoutSeconds: number = WAIT_TIMEOUT_DEFAULT_SECONDS) =>
      waitAs(apiKey, id, timeoutSeconds),
    cancel: (id: string) => cancelAs(apiKey, id),
  });
}

/**
 * One header's value, or undefined when it is absent or blank. A value with
 * `get` is read through it (a fetch `Headers` is case-insensitive by
 * specification); anything else is a plain object whose names are compared
 * lower-cased, and whose value may be an array, of which the first is taken.
 */
function headerValue(headers: HeaderSource, name: string): string | undefined {
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    return usable(
      (headers as { get(name: string): string | null }).get(name) ?? undefined
    );
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const found = usable(Array.isArray(value) ? value[0] : value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function usable(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * This machine's inline cap, or null when it cannot be read.
 *
 * NOT A REFUSAL WHEN ABSENT. The cap is the platform's to enforce and it does —
 * an oversized result is dropped and recorded as `too_large` — so the check
 * here is a courtesy that turns a silent drop into something the caller can act
 * on. Declining to write because the courtesy is unavailable would lose a
 * result the platform would have accepted, which is strictly worse than not
 * checking.
 */
function inlineMaxBytes(): number | null {
  const raw = process.env.AETHERFY_RUN_INLINE_MAX_BYTES;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * The control plane's URL for one run.
 *
 * A run is a deployment row — the ephemeral kind — so it is read from
 * `/deployments/{id}`, the same route and the same object a deploy is read
 * from. That is the platform's shape, not a convenience: one row, one reader.
 */
function runUrl(runId: string): string {
  const apiUrl = requireEnv('AETHERFY_API_URL', "the control plane's base URL");
  if (!runId) {
    throw new AgentError("runId must be a run's id, not an empty string.");
  }
  return `${apiUrl.replace(/\/+$/, '')}/deployments/${encodeURIComponent(runId)}`;
}

/**
 * The key this process was started with: on a task machine the run's own, in a
 * service the release's. What the module-level functions send.
 */
function environmentKey(purpose: string): string {
  return requireEnv('AETHERFY_API_KEY', purpose);
}

/**
 * The one place a response's deployment object becomes a {@link Run}: a read and
 * a cancel both hand one back.
 */
function runFrom(record: Record<string, unknown>): Run {
  return {
    id: stringOf(record.id),
    agent_id: stringOf(record.agent_id),
    state: stringOf(record.state),
    result: record.result ?? null,
    result_error:
      typeof record.result_error === 'string' ? record.result_error : null,
    has_result: record.has_result === true,
    is_ephemeral: record.is_ephemeral === true,
    error_message:
      typeof record.error_message === 'string' ? record.error_message : null,
    raw: record,
  };
}

/**
 * The two refusals every call on a run answers in the same words, as the types
 * they have: no run has that id, and the run is another account's. Undefined
 * for anything else.
 */
function sharedRunRefusal(
  status: number,
  code: string | undefined,
  message: string,
  detail: Record<string, unknown>
): RunReadError | undefined {
  if (status === 404 && code === DEPLOYMENT_NOT_FOUND) {
    return new RunNotFound(message, detail);
  }
  if (status === 403 && code === DEPLOYMENT_ACCESS_DENIED) {
    return new RunAccessDenied(message, detail);
  }
  return undefined;
}

/**
 * One GET, one Run — shared by {@link result} and {@link wait}, for whichever
 * key they are given.
 *
 * ONE implementation because the two routes return the SAME object and refuse
 * in the SAME words; the control plane loads both through one function for
 * exactly that reason. Two readers here is how one of them ends up mapping a
 * 403 the other maps as a 404.
 */
async function readRun(
  url: string,
  apiKey: string,
  options: { timeoutMs?: number; repeatable?: boolean } = {}
): Promise<Run> {
  const { status, body, retryAfter } = await requestJson('GET', url, {
    apiKey,
    userAgent: userAgent(),
    timeoutMs: options.timeoutMs,
    repeatable: options.repeatable ?? true,
  });

  if (status === 200) {
    const record = asRecord(body);
    if (!record) {
      throw new RunReadError(
        'Reading the run answered 200 with a body that is not an object, so ' +
          'there is no run to return.',
        { status }
      );
    }
    return runFrom(record);
  }

  const detail = detailOf(body);
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : `Reading the run failed with status ${status}.`;
  const code = typeof detail.code === 'string' ? detail.code : undefined;

  // THE CODE DECIDES, NOT THE STATUS ALONE — the same rule spawn() follows, for
  // the same reason. 404 and 403 are categories the control plane reuses across
  // every route; DEPLOYMENT_NOT_FOUND and DEPLOYMENT_ACCESS_DENIED are what it
  // publishes and promises not to rename. An unrecognised pairing falls through
  // to RunReadError, which reports exactly what arrived.
  const refusal = sharedRunRefusal(status, code, message, detail);
  if (refusal) throw refusal;
  if (status === 422 && code === DEPLOYMENT_WAIT_TIMEOUT_INVALID) {
    throw new WaitTimeoutInvalid(message, detail);
  }
  throw new RunReadError(message, { status, code, detail, retryAfter });
}

/**
 * Resolve `AETHERFY_SPAWN_URL` into the URL to POST to.
 *
 * THE VARIABLE IS A TEMPLATE, not a finished URL. The platform injects
 * `.../agents/{id}/spawn` with `{id}` left as a literal placeholder —
 * substituted here with this machine's own agent id, because the path
 * parameter names the PARENT of the spawn, which is us. A helper that POSTed
 * the variable verbatim would send a request to a path containing a literal
 * brace and get a 404 that explains nothing.
 *
 * A platform that starts injecting an already-resolved URL keeps working: the
 * substitution only fires when the placeholder is actually present.
 */
function spawnUrl(): string {
  const url = requireEnv('AETHERFY_SPAWN_URL', 'the spawn endpoint');
  if (!url.includes('{id}')) return url;
  const agentId = requireEnv(
    'AETHERFY_AGENT_ID',
    "this agent's id, the spawn's parent"
  );
  return url.split('{id}').join(agentId);
}

export interface AgentUrlOptions {
  /**
   * Skip the in-process memory, ask the control plane, and replace the entry.
   * Defaults to false.
   */
  fresh?: boolean;
}

// Derived from the type by optionKeys(): see src/utils/options.ts.
const AGENT_URL_OPTION_KEYS = optionKeys<AgentUrlOptions>({ fresh: true });

/**
 * Return the current public URL of a peer agent, found by name.
 *
 * A peer is an agent of THIS agent's own workspace; `name` is the name it has
 * there. The URL is what the platform serves the peer at right now, so a peer
 * that was deleted and created again is found at its new address and nothing
 * here, or in this machine's environment, has to change.
 *
 * THE ANSWER IS REMEMBERED FOR `PEER_CACHE_SECONDS` (30) PER NAME, in this
 * process only, with no request while it is fresh. `{ fresh: true }` skips that
 * memory, asks the control plane and replaces the entry; use it when an
 * address you were handed has just stopped answering. {@link callAgent} does
 * exactly that, once, by itself.
 *
 * Only the NAME to URL pair is kept. A refusal is never kept, so a peer that is
 * created a moment after a {@link PeerNotFound} is found on the next call.
 *
 * WHEN THE CONTROL PLANE CANNOT ANSWER (429, 5xx, or no connection), the last
 * address known for the peer is returned if there is one, and the control plane
 * is not asked again before its `Retry-After` (between
 * `PEER_RETRY_FLOOR_SECONDS` and `PEER_RETRY_CAP_SECONDS`): stale beats failing
 * a call that would have worked. With no known address the failure is thrown.
 * `{ fresh: true }` is never answered from memory, and a 404 or 409 drops the
 * known address.
 *
 * @throws {PeerNotFound} 404 `AGENT_NOT_FOUND`, the workspace has no agent of
 *   that name.
 * @throws {PeerHasNoUrl} 409 `PEER_HAS_NO_URL`, the agent exists but nothing
 *   listens on it.
 * @throws {PeerLookupError} Any other refusal, among them 403
 *   `AUTH_AGENT_KEY_OUT_OF_SCOPE` — read `code`, not the prose.
 * @throws {NotRunningOnAgent} `AETHERFY_PEERS_URL` or `AETHERFY_API_KEY` is not
 *   set.
 * @throws {AgentError} `name` is empty. No request is sent.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function agentUrl(
  name: string,
  options: AgentUrlOptions = {}
): Promise<string> {
  assertAllowedOptionKeys(options, AGENT_URL_OPTION_KEYS, 'agentUrl');
  if (!name) {
    throw new AgentError(
      "name must be a peer agent's name, not an empty string."
    );
  }
  if (!options.fresh) {
    const cached = peerCache.getUrl(name);
    if (cached !== undefined) return cached;
  }

  const waiting = peerCache.blocked(name);
  if (waiting !== undefined) {
    const stale = options.fresh ? undefined : peerCache.lastKnownUrl(name);
    if (stale !== undefined) return stale;
    throw stillWaiting(`Looking up '${name}'`, waiting);
  }

  let body: Record<string, unknown>;
  try {
    body = await lookupPeers(`${peersUrl()}/${encodeURIComponent(name)}`, name);
  } catch (error) {
    if (error instanceof PeerNotFound || error instanceof PeerHasNoUrl) {
      peerCache.forgetUrl(name);
      throw error;
    }
    if (!controlPlaneCouldNotAnswer(error)) throw error;
    blockLookup(name, error);
    const stale = options.fresh ? undefined : peerCache.lastKnownUrl(name);
    if (stale !== undefined) return stale;
    throw error;
  }
  const url = body.url;
  if (typeof url !== 'string' || url === '') {
    throw new PeerLookupError(
      `The lookup of '${name}' answered 200 with no 'url', so there is no ` +
        'address to return.',
      { status: 200, detail: body }
    );
  }
  peerCache.putUrl(name, url);
  return url;
}

/**
 * Return every addressable peer of this agent's workspace as `{ name: url }`.
 *
 * The workspace's other agents that have a public URL; this agent is not in it,
 * and neither is an agent nothing listens on. The same memory rule as
 * {@link agentUrl}: the whole answer is remembered for `PEER_CACHE_SECONDS`
 * (30) as one entry, and `{ fresh: true }` skips it and replaces it. The two
 * memories are separate: this list is not read to answer {@link agentUrl}, nor
 * the other way round.
 *
 * The object is a copy: editing it does not edit what is remembered.
 *
 * The same fallback as {@link agentUrl}: when the control plane cannot answer,
 * the last list known is returned, and the control plane is not asked again
 * before its `Retry-After`.
 *
 * @throws {PeerLookupError} A refusal, among them 403
 *   `AUTH_AGENT_KEY_OUT_OF_SCOPE` — read `code`, not the prose.
 * @throws {NotRunningOnAgent} `AETHERFY_PEERS_URL` or `AETHERFY_API_KEY` is not
 *   set.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function agentUrls(
  options: AgentUrlOptions = {}
): Promise<Record<string, string>> {
  assertAllowedOptionKeys(options, AGENT_URL_OPTION_KEYS, 'agentUrls');
  if (!options.fresh) {
    const cached = peerCache.getList();
    if (cached !== undefined) return cached;
  }

  const waiting = peerCache.blocked(null);
  if (waiting !== undefined) {
    const staleList = options.fresh ? undefined : peerCache.lastKnownList();
    if (staleList !== undefined) return staleList;
    throw stillWaiting('Listing the peers', waiting);
  }

  let body: Record<string, unknown>;
  try {
    body = await lookupPeers(peersUrl(), null);
  } catch (error) {
    if (!controlPlaneCouldNotAnswer(error)) throw error;
    blockLookup(null, error);
    const staleList = options.fresh ? undefined : peerCache.lastKnownList();
    if (staleList !== undefined) return staleList;
    throw error;
  }
  const peers = body.peers;
  if (!Array.isArray(peers)) {
    throw new PeerLookupError(
      "The peer list answered 200 with no 'peers' list, so there is nothing " +
        'to return.',
      { status: 200, detail: body }
    );
  }
  const urls: Record<string, string> = {};
  for (const peer of peers) {
    const entry = asRecord(peer);
    const peerName = entry?.name;
    const peerUrl = entry?.url;
    if (
      typeof peerName !== 'string' ||
      peerName === '' ||
      typeof peerUrl !== 'string' ||
      peerUrl === ''
    ) {
      throw new PeerLookupError(
        'The peer list answered 200 with an entry that has no name and url: ' +
          `${JSON.stringify(peer)}.`,
        { status: 200, detail: body }
      );
    }
    urls[peerName] = peerUrl;
  }
  peerCache.putList(urls);
  return { ...urls };
}

export interface CallAgentInit {
  /** The HTTP method. Defaults to `'GET'`. */
  method?: string;
  /**
   * The request body, encoded as JSON, with a `Content-Type` of
   * `application/json` unless `headers` names one. `undefined` sends no body;
   * every other value, `null` included, is a body.
   */
  json?: unknown;
  /** Headers for the peer, beside the `User-Agent` this helper sets. */
  headers?: Record<string, string>;
  /** Seconds for the request. Defaults to 30. */
  timeout?: number;
}

// Derived from the type by optionKeys(): see src/utils/options.ts.
const CALL_AGENT_OPTION_KEYS = optionKeys<CallAgentInit>({
  method: true,
  json: true,
  headers: true,
  timeout: true,
});

/**
 * Call a peer agent over HTTP and return its answer.
 *
 * Looks `name` up with {@link agentUrl} and sends `init.method` to the URL plus
 * `path` (which starts with `/`). `init.json`, when given, is the request body
 * encoded as JSON, with a `Content-Type` of `application/json` unless
 * `init.headers` names one. `init.timeout` is seconds for the request.
 *
 * THE PEER IS ANOTHER SERVICE, so it is never sent this machine's Aetherfy key:
 * only the lookup carries it. Whatever authentication the peer wants is yours
 * to put in `init.headers`.
 *
 * ONE RE-LOOKUP, AND ONLY FOR AN ADDRESS THAT IS GONE. The call is repeated
 * once, at a freshly looked-up URL (`agentUrl(name, { fresh: true })`), when
 * the first attempt PROVABLY NEVER REACHED A PEER (the name does not resolve,
 * or the connection was refused: nothing accepted it) or when the edge REFUSED
 * the address: a 404 whose JSON body is `{"error": {"code": "AGENT_NOT_FOUND"}}` or
 * `AGENT_NOT_REACHABLE`, which is what a retired address answers. That is how a
 * peer recreated inside the cache window is found without a restart. A second
 * failure of either kind throws; nothing is retried again.
 *
 * EVERY OTHER STATUS IS RETURNED, never retried and never thrown, 5xx
 * included: the peer answered, and only you know what its answer means. A
 * redirect is such an answer: it is returned, not followed, so a `POST` is never
 * quietly replayed to a host you did not name. A RESET OR A TIMEOUT IS NOT
 * RETRIED: either can happen after the peer has acted, so the call throws an
 * `AgentTransportError` and whether to repeat it is yours to say. A request that
 * is not safe to repeat (a `POST` that charges a card) should carry its own
 * idempotency key.
 *
 * @throws {PeerNotFound} 404 `AGENT_NOT_FOUND`, the workspace has no agent of
 *   that name.
 * @throws {PeerHasNoUrl} 409 `PEER_HAS_NO_URL`, the agent exists but nothing
 *   listens on it.
 * @throws {PeerLookupError} Any other refusal of the lookup.
 * @throws {AgentTransportError} The peer did not answer and the request may or
 *   may not have run (a reset or a timeout); or it could not be reached at the
 *   freshly looked-up address either, or that address was refused too, or the
 *   lookup never reached the control plane.
 * @throws {NotRunningOnAgent} `AETHERFY_PEERS_URL` or `AETHERFY_API_KEY` is not
 *   set.
 * @throws {AgentError} `name` is empty, `path` does not start with `/` or
 *   `timeout` is not positive. No request is sent.
 */
export async function callAgent(
  name: string,
  path: string,
  init: CallAgentInit = {}
): Promise<PeerResponse> {
  assertAllowedOptionKeys(init, CALL_AGENT_OPTION_KEYS, 'callAgent');
  if (!path.startsWith('/')) {
    throw new AgentError(
      `path must start with '/', as in '/summarise', not ${JSON.stringify(path)}.`
    );
  }
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const timeoutMs =
    init.timeout === undefined ? DEFAULT_TIMEOUT_MS : init.timeout * 1000;
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw new AgentError(
      `timeout must be a positive number of seconds, not ${String(init.timeout)}.`
    );
  }

  const attempt = (base: string): Promise<PeerAttempt> =>
    requestPeer(method, base.replace(/\/+$/, '') + path, {
      userAgent: userAgent(),
      body,
      headers,
      timeoutMs,
    });

  const first = (await attempt(await agentUrl(name))).response;
  if (first !== undefined && refusedCode(first) === undefined) {
    return first;
  }

  const second = await attempt(await agentUrl(name, { fresh: true }));
  if (second.response === undefined) {
    throw new AgentTransportError(
      `The peer '${name}' did not answer at its freshly looked-up address, ` +
        `nor at the one it had before: ${second.failure}`
    );
  }
  const refused = refusedCode(second.response);
  if (refused !== undefined) {
    throw new AgentTransportError(
      `The peer '${name}' was refused (${refused}) at its freshly looked-up ` +
        'address, as at the one it had before.'
    );
  }
  return second.response;
}

/** The code of an address the edge refused, or undefined for any other answer. */
function refusedCode(response: PeerResponse): string | undefined {
  if (response.status !== 404) return undefined;
  let body: unknown;
  try {
    body = response.json();
  } catch {
    return undefined;
  }
  const code = asRecord(asRecord(body)?.error)?.code;
  return code === AGENT_NOT_FOUND || code === AGENT_NOT_REACHABLE
    ? code
    : undefined;
}

/**
 * Resolve `AETHERFY_PEERS_URL` into the URL to GET, without a trailing slash.
 *
 * A TEMPLATE, exactly as {@link spawnUrl} explains for its variable: the
 * platform leaves `{id}` as a literal placeholder in `.../agents/{id}/peers`,
 * and the id that belongs there is this machine's own agent, because these are
 * THIS agent's peers.
 */
function peersUrl(): string {
  let url = requireEnv('AETHERFY_PEERS_URL', 'the peer lookup endpoint');
  if (url.includes('{id}')) {
    const agentId = requireEnv(
      'AETHERFY_AGENT_ID',
      "this agent's id, whose peers these are"
    );
    url = url.split('{id}').join(agentId);
  }
  return url.replace(/\/+$/, '');
}

/**
 * One GET against the peers route, shared by {@link agentUrl} and
 * {@link agentUrls}: the two answer in the same envelope and refuse in the same
 * words, so there is one place that maps the refusal.
 *
 * THE CODE DECIDES, NOT THE STATUS ALONE, as in {@link spawn}. 404 and 409 are
 * categories the control plane reuses; `AGENT_NOT_FOUND` and `PEER_HAS_NO_URL`
 * are what it promises not to rename.
 */
/**
 * A lookup that failed for the control plane's state, not for what was asked: no connection, 429 or 5xx.
 * A 403, a 404 and a 409 are ANSWERS and are never served around.
 */
function controlPlaneCouldNotAnswer(error: unknown): boolean {
  if (error instanceof AgentTransportError) return true;
  if (!(error instanceof PeerLookupError)) return false;
  const status = error.status;
  return status !== undefined && (status === 429 || status >= 500);
}

function blockLookup(key: string | null, error: unknown): void {
  const failed = error instanceof PeerLookupError ? error : undefined;
  peerCache.block(
    key,
    retryDelay(failed?.retryAfter),
    failed?.status,
    failed?.code
  );
}

/** The failure of the lookup being waited out, thrown instead of asking again. */
function stillWaiting(what: string, waiting: PeerWait): PeerLookupError {
  return new PeerLookupError(
    `${what} failed a moment ago (${waiting.status ?? 'no connection'}) and the ` +
      `control plane is not asked again for ${Math.round(waiting.left)} more ` +
      'second(s); no earlier address is known.',
    {
      status: waiting.status,
      code: waiting.code,
      retryAfter: waiting.left,
    }
  );
}

async function lookupPeers(
  url: string,
  name: string | null
): Promise<Record<string, unknown>> {
  const apiKey = requireEnv(
    'AETHERFY_API_KEY',
    'the key a peer lookup authenticates with'
  );
  const { status, body, retryAfter } = await requestJson('GET', url, {
    apiKey,
    userAgent: userAgent(),
    repeatable: true,
  });

  if (status === 200) {
    const record = asRecord(body);
    if (!record) {
      throw new PeerLookupError(
        'The peer lookup answered 200 with a body that is not an object, so ' +
          'there is nothing to return.',
        { status }
      );
    }
    return record;
  }

  const detail = detailOf(body);
  const what = name ? `Looking up '${name}'` : 'Listing the peers';
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : `${what} failed with status ${status}.`;
  const code = typeof detail.code === 'string' ? detail.code : undefined;
  if (status === 404 && code === AGENT_NOT_FOUND) {
    throw new PeerNotFound(message, detail);
  }
  if (status === 409 && code === PEER_HAS_NO_URL) {
    throw new PeerHasNoUrl(message, detail);
  }
  throw new PeerLookupError(message, { status, code, detail, retryAfter });
}
