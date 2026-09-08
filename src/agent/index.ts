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
 *   payload, machine, fanOut, spawn, writeResult, result, wait,
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
 * ```
 *
 * TWO HALVES, and they are the same contract read from opposite ends. A task
 * reads its payload and writes its result; whoever started it spawns and then
 * reads that result back. `payload`/`writeResult` are files on the machine and
 * touch no network at all; `spawn`/`result`/`wait` are the control plane, and
 * are the only calls here that do.
 *
 * It ships inside the `aetherfy-vectors` package as the `aetherfy-vectors/agent`
 * subpath, and the standard runtime image preinstalls that package — so on a
 * plain agent these names import with nothing in your package.json. A custom
 * container installs it itself.
 *
 * @public
 */

import { readFile, writeFile } from 'node:fs/promises';

import {
  AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED,
  AgentError,
  AgentTransportError,
  DEPLOYMENT_ACCESS_DENIED,
  DEPLOYMENT_NOT_FOUND,
  DEPLOYMENT_WAIT_TIMEOUT_INVALID,
  NotRunningOnAgent,
  PayloadTooLarge,
  PayloadUnavailable,
  RUN_PAYLOAD_TOO_LARGE,
  ResultTooLarge,
  RunAccessDenied,
  RunNotFound,
  RunReadError,
  SpawnError,
  TooManyRunsInFlight,
  WaitTimeoutInvalid,
} from './errors';
import { requestJson, USER_AGENT_PREFIX } from './http';
import { MachineShape, Run, Spawn } from './models';
import { SDK_VERSION } from '../version';

export {
  AgentError,
  AgentTransportError,
  NotRunningOnAgent,
  PayloadTooLarge,
  PayloadUnavailable,
  ResultTooLarge,
  RunAccessDenied,
  RunNotFound,
  RunReadError,
  SpawnError,
  TooManyRunsInFlight,
  WaitTimeoutInvalid,
};
export type { MachineShape, Run, Spawn };

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
  "Aetherfy offers it to a `type: job` machine before each run's entrypoint " +
  'starts, and only when that machine also carries an inline result cap ' +
  '(AETHERFY_RUN_INLINE_MAX_BYTES) — without the cap the platform cannot ' +
  'accept a result and does not offer the path. A `service` agent never gets ' +
  'one: a result belongs to a run.';

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
 * Ask the control plane to run another task agent, and return once recorded.
 *
 * `child` is the id or name of a `type: job` agent you own; the parent is this
 * machine's own agent. The child runs in this agent's region, and the two must
 * be connected by `spawn.workers` in `aetherfy.yaml` for the call to be
 * allowed.
 *
 * ACCEPTANCE IS NOT EXECUTION. The returned {@link Spawn} says the run was
 * recorded and its deploy queued. Aetherfy never queues a run behind another,
 * so a spawn aimed at an agent already running fails as busy rather than
 * waiting — check the run's status.
 *
 * Keep the payload small: it is for parameters and references, not data. Pass
 * anything large by reference to a collection.
 *
 * @throws {PayloadTooLarge} 413, the payload crossed the inline cap.
 * @throws {TooManyRunsInFlight} 429, the concurrent-run cap is full. The one
 *   failure here worth retrying.
 * @throws {SpawnError} Any other refusal — read `code`, not the prose.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function spawn(
  child: string,
  spawnPayload?: Record<string, unknown>
): Promise<Spawn> {
  const apiKey = requireEnv(
    'AETHERFY_API_KEY',
    'the key a spawn authenticates with'
  );
  const url = spawnUrl();

  const { status, body } = await requestJson('POST', url, {
    apiKey,
    userAgent: userAgent(),
    body: { child_agent_id: child, payload: spawnPayload ?? {} },
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
    return {
      spawn_id: stringOf(record.spawn_id),
      job_id: stringOf(record.job_id),
      child_agent_id: stringOf(record.child_agent_id),
      region: stringOf(record.region),
      status: stringOf(record.status),
      workspace: typeof record.workspace === 'string' ? record.workspace : null,
      estimated_start:
        typeof record.estimated_start === 'string'
          ? record.estimated_start
          : undefined,
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
  if (status === 429 && code === AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED) {
    throw new TooManyRunsInFlight(message, {
      inFlightCount: numberOf(detail, 'in_flight_count'),
      limit: stringOrNull(detail, 'limit'),
      maxInFlightRuns: numberOf(detail, 'max_in_flight_runs'),
      detail,
    });
  }
  throw new SpawnError(message, { status, code, detail });
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
 * Answers immediately with the run as it stands. A run that is still going has
 * `state === 'active'` and no result yet; {@link wait} is the same read with
 * the waiting done server-side, and is what to use when the answer is the
 * point.
 *
 * `runId` is a run's id — `Spawn.spawn_id` from a {@link spawn}, or the id of
 * this run itself in `AETHERFY_SPAWN_ID`.
 *
 * @throws {RunNotFound} 404, no run has that id.
 * @throws {RunAccessDenied} 403, the run belongs to another account.
 * @throws {RunReadError} Any other refusal — read `code`, not the prose.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function result(runId: string): Promise<Run> {
  return readRun(runUrl(runId));
}

/**
 * Hold one request open until the run finishes, then return it.
 *
 * The read side of the result path, and the reason a parent does not poll:
 * without it every caller writes the same loop with its own interval, and all
 * of them pay for the privilege of not knowing yet.
 *
 * A TIMEOUT IS NOT AN ERROR. If the run has not finished in `timeoutSeconds`
 * this returns it exactly as it stands — read `Run.state`, which is `active`
 * while a run is executing and `completed` or `failed` when it is over, and
 * call again. Waiting longer than the maximum is a second call, not a bigger
 * number: the request is held open, and anything longer is cut by the network
 * in front of Aetherfy.
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
 * @throws {RunAccessDenied} 403, the run belongs to another account.
 * @throws {RunReadError} Any other refusal.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function wait(
  runId: string,
  timeoutSeconds: number = WAIT_TIMEOUT_DEFAULT_SECONDS
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
  return readRun(`${runUrl(runId)}/wait?timeout_seconds=${seconds}`, {
    timeoutMs: (seconds + WAIT_TRANSPORT_MARGIN_SECONDS) * 1000,
    retryConnectionErrors: false,
  });
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
 * One GET, one Run — shared by {@link result} and {@link wait}.
 *
 * ONE implementation because the two routes return the SAME object and refuse
 * in the SAME words; the control plane loads both through one function for
 * exactly that reason. Two readers here is how one of them ends up mapping a
 * 403 the other maps as a 404.
 */
async function readRun(
  url: string,
  options: { timeoutMs?: number; retryConnectionErrors?: boolean } = {}
): Promise<Run> {
  const apiKey = requireEnv('AETHERFY_API_KEY', 'the key a run is read with');
  const { status, body } = await requestJson('GET', url, {
    apiKey,
    userAgent: userAgent(),
    timeoutMs: options.timeoutMs,
    retryConnectionErrors: options.retryConnectionErrors,
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
  if (status === 404 && code === DEPLOYMENT_NOT_FOUND) {
    throw new RunNotFound(message, detail);
  }
  if (status === 403 && code === DEPLOYMENT_ACCESS_DENIED) {
    throw new RunAccessDenied(message, detail);
  }
  if (status === 422 && code === DEPLOYMENT_WAIT_TIMEOUT_INVALID) {
    throw new WaitTimeoutInvalid(message, detail);
  }
  throw new RunReadError(message, { status, code, detail });
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
