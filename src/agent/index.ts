/**
 * Aetherfy Agent — the four things code running on an Aetherfy machine does.
 *
 * This is a THIN wrapper over contracts the platform already publishes. It
 * invents no protocol: every call here has a hand-rolled equivalent in
 * https://docs.aetherfy.com/agents/task-contract, and the helper exists so
 * that equivalent stops being copied into every task.
 *
 * ```javascript
 * const { payload, machine, fanOut, spawn } = require('aetherfy-vectors/agent');
 *
 * const data = await payload();              // this run's input, {} when none
 * const shape = machine();                   // vcpus / memory_mb / region
 * const results = await fanOut(work, data.items ?? []);
 * await spawn('nightly-rollup', { date: '2026-09-07' });
 * ```
 *
 * It ships inside the `aetherfy-vectors` package as the `aetherfy-vectors/agent`
 * subpath, and the standard runtime image preinstalls that package — so on a
 * plain agent these four names import with nothing in your package.json. A
 * custom container installs it itself.
 *
 * Nothing here reaches the network except `spawn` and the fallback branch of
 * `payload`.
 *
 * There is deliberately no `result()` and no `wait()`. A run reports its
 * outcome through its exit code, and the platform's result path is not built
 * yet; adding a method that pretended otherwise would be inventing protocol.
 *
 * @public
 */

import { readFile } from 'node:fs/promises';

import {
  AgentError,
  AgentTransportError,
  NotRunningOnAgent,
  PayloadTooLarge,
  PayloadUnavailable,
  SpawnError,
  TooManyRunsInFlight,
} from './errors';
import { requestJson, USER_AGENT_PREFIX } from './http';
import { MachineShape, Spawn } from './models';
import { SDK_VERSION } from '../version';

export {
  AgentError,
  AgentTransportError,
  NotRunningOnAgent,
  PayloadTooLarge,
  PayloadUnavailable,
  SpawnError,
  TooManyRunsInFlight,
};
export type { MachineShape, Spawn };

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

function userAgent(): string {
  return `${USER_AGENT_PREFIX}${AGENT_HELPER_VERSION}`;
}

function requireEnv(variable: string, purpose: string): string {
  const value = process.env[variable];
  if (!value) throw new NotRunningOnAgent(variable, purpose);
  return value;
}

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

  const url = `${apiUrl.replace(/\/+$/, '')}/deployments/${spawnId}/payload`;
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

  if (status === 413) {
    throw new PayloadTooLarge(message, {
      payloadBytes: numberOf(detail, 'payload_bytes'),
      maxBytes: numberOf(detail, 'max_bytes'),
      detail,
    });
  }
  if (status === 429) {
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
