/**
 * Errors for the Aetherfy Agent helper.
 *
 * Extends `AetherfyVectorsError` so one `catch` around agent code sees
 * vector-db errors and agent-runtime errors alike, and so `instanceof
 * AetherfyVectorsError` still matches. Mirrors `src/memory/errors.ts`,
 * including the prototype re-set after `super()` that ES5-target Error
 * subclassing requires — without it `instanceof` breaks for every subclass.
 *
 * Only three spawn outcomes are worth telling apart, and they are the three the
 * control plane distinguishes: the payload was too big
 * (413 RUN_PAYLOAD_TOO_LARGE), too many runs are already in flight
 * (429 AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED), and everything else.
 * "Everything else" is any other status AND any other code on those two
 * statuses: the pairing is what selects a type, so a 413 the platform grows for
 * some new reason arrives as a plain SpawnError reporting its own code rather
 * than wearing this one's.
 *
 * READING A RUN BACK has its own small family below, under `RunReadError`, and
 * it follows exactly the same rule. It is a SEPARATE family from `SpawnError`
 * rather than a widening of it, because the two calls fail at different things:
 * a spawn is refused for what you asked to start, a read for what you asked to
 * see. `ResultTooLarge` sits outside both — it is thrown before anything leaves
 * the machine.
 */

import { AetherfyVectorsError } from '../exceptions';

/**
 * The two platform error codes this module gives a type of its own.
 *
 * ONE definition each, because they are used TWICE: to decide which type a
 * refusal becomes, and to stamp that type's `code`. Two literals would let the
 * dispatch and the stamp disagree, which is the one way an error could report
 * a code the platform never sent.
 */
export const RUN_PAYLOAD_TOO_LARGE = 'RUN_PAYLOAD_TOO_LARGE';
export const AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED =
  'AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED';

export class AgentError extends AetherfyVectorsError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
    Object.setPrototypeOf(this, AgentError.prototype);
  }
}

/**
 * A variable the platform sets on every agent machine is missing.
 *
 * This helper reads the run's environment; off a machine there is no run and
 * nothing to read. Seeing this locally means the code is running somewhere
 * Aetherfy did not start it.
 *
 * `remedy` REPLACES THE SECOND SENTENCE, and exists because the default one is
 * not true of every variable. "The platform sets it before your entrypoint
 * starts" holds for the variables Aetherfy injects unconditionally; it is a lie
 * for `AETHERFY_SPAWN_RESULT_PATH`, which a task machine is offered only when
 * it also carries a result cap, and which a `service` machine never gets at
 * all. A caller sent looking for a bug in their own code by a message that
 * confidently describes the wrong world is worse off than one told nothing.
 */
export class NotRunningOnAgent extends AgentError {
  constructor(
    public readonly variable: string,
    purpose: string,
    remedy?: string
  ) {
    super(
      `${variable} is not set, so ${purpose} cannot be read. ` +
        (remedy ??
          `This helper is for code running on an Aetherfy agent machine; the ` +
            `platform sets ${variable} before your entrypoint starts.`)
    );
    this.name = 'NotRunningOnAgent';
    Object.setPrototypeOf(this, NotRunningOnAgent.prototype);
  }
}

/** Neither the payload file nor the HTTP fallback yielded a payload. */
export class PayloadUnavailable extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadUnavailable';
    Object.setPrototypeOf(this, PayloadUnavailable.prototype);
  }
}

/**
 * The control plane refused a spawn.
 *
 * `code` is the platform's stable error code (`detail.code` in the
 * control-plane envelope) and is the thing to branch on; the message is prose
 * that may be reworded at any time.
 */
export class SpawnError extends AgentError {
  public readonly status?: number;
  public readonly code?: string;
  public readonly detail: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'SpawnError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    Object.setPrototypeOf(this, SpawnError.prototype);
  }
}

/**
 * `413 RUN_PAYLOAD_TOO_LARGE` — the spawn payload crossed the inline cap.
 *
 * The payload carries parameters and references, not data. Write the data to a
 * collection and pass its id.
 */
export class PayloadTooLarge extends SpawnError {
  public readonly payloadBytes?: number;
  public readonly maxBytes?: number;

  constructor(
    message: string,
    options: {
      payloadBytes?: number;
      maxBytes?: number;
      detail?: Record<string, unknown>;
    } = {}
  ) {
    super(message, {
      status: 413,
      code: RUN_PAYLOAD_TOO_LARGE,
      detail: options.detail,
    });
    this.name = 'PayloadTooLarge';
    this.payloadBytes = options.payloadBytes;
    this.maxBytes = options.maxBytes;
    Object.setPrototypeOf(this, PayloadTooLarge.prototype);
  }
}

/**
 * `429 AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED` — the account's runs-in-flight
 * cap is full.
 *
 * Retryable, unlike the other two: wait for runs to finish and spawn again.
 *
 * THE CAP IS THE ACCOUNT'S, NOT THE AGENT'S, and it is set by the plan.
 * `limit` names WHICH plan limit was hit — a stable string the platform
 * documents as switchable-on — and `maxInFlightRuns` is its value.
 * `maxInFlightRuns` is `null` when the plan declares no cap, so a caller
 * building a message from it must not assume a number.
 *
 * `limit` was `"max_in_flight_runs"` at the time of writing and is the only
 * value the platform sends today; it is read from the envelope rather than
 * assumed, so a second named limit reaching this status arrives intact
 * instead of being reported as the first one.
 */
export class TooManyRunsInFlight extends SpawnError {
  public readonly inFlightCount: number | null;
  public readonly limit: string | null;
  public readonly maxInFlightRuns: number | null;

  constructor(
    message: string,
    options: {
      inFlightCount?: number | null;
      limit?: string | null;
      maxInFlightRuns?: number | null;
      detail?: Record<string, unknown>;
    } = {}
  ) {
    super(message, {
      status: 429,
      code: AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED,
      detail: options.detail,
    });
    this.name = 'TooManyRunsInFlight';
    // Absent and explicitly-null both surface as null, so the two languages
    // agree: Python collapses them to None and a caller porting a task between
    // them should not find one of them reading `undefined`.
    this.inFlightCount = options.inFlightCount ?? null;
    this.limit = options.limit ?? null;
    this.maxInFlightRuns = options.maxInFlightRuns ?? null;
    Object.setPrototypeOf(this, TooManyRunsInFlight.prototype);
  }
}

/** The request never reached the control plane at all. */
export class AgentTransportError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTransportError';
    Object.setPrototypeOf(this, AgentTransportError.prototype);
  }
}

/**
 * The three control-plane error codes the run-reading calls give a type of
 * their own. ONE definition each, for the same reason as the two above: the
 * code both SELECTS the type and is STAMPED on it, and two literals could
 * disagree.
 *
 * The first two are the deployment read's existing contract, and the /wait
 * route answers with them identically by construction — one loader serves both
 * routes upstream, so a caller need not know which one it called.
 */
export const DEPLOYMENT_NOT_FOUND = 'DEPLOYMENT_NOT_FOUND';
export const DEPLOYMENT_ACCESS_DENIED = 'DEPLOYMENT_ACCESS_DENIED';
export const DEPLOYMENT_WAIT_TIMEOUT_INVALID =
  'DEPLOYMENT_WAIT_TIMEOUT_INVALID';

/**
 * `writeResult` was given more than this machine's inline cap.
 *
 * THE PLATFORM WOULD NOT HAVE FAILED THE RUN. A result over the cap is dropped
 * and the run records `result_error: 'too_large'` beside an empty result — the
 * exit code is still the run's outcome. This helper refuses at the write
 * instead, because a value discarded silently is a value the caller never
 * learns to shrink: whoever spawned the run finds out, and the code that could
 * have written the data to a collection and returned its id does not.
 *
 * Mirrors {@link PayloadTooLarge}, which is the same cap in the other direction
 * — one number bounds both. It is NOT a subclass of it, and not of
 * {@link SpawnError} either: nothing here crossed the network, so there is no
 * status and no platform code to carry.
 *
 * `maxBytes` is read from `AETHERFY_RUN_INLINE_MAX_BYTES`, which the platform
 * injects on every task machine.
 */
export class ResultTooLarge extends AgentError {
  public readonly resultBytes: number | null;
  public readonly maxBytes: number | null;

  constructor(
    message: string,
    options: { resultBytes?: number | null; maxBytes?: number | null } = {}
  ) {
    super(message);
    this.name = 'ResultTooLarge';
    this.resultBytes = options.resultBytes ?? null;
    this.maxBytes = options.maxBytes ?? null;
    Object.setPrototypeOf(this, ResultTooLarge.prototype);
  }
}

/**
 * The control plane refused to hand over a run.
 *
 * `code` is the platform's stable error code (`detail.code` in the
 * control-plane envelope) and is the thing to branch on; the message is prose
 * that may be reworded at any time.
 *
 * Same discipline as {@link SpawnError}: the STATUS AND THE CODE together
 * select a subclass, and an unrecognised pairing arrives as this class
 * reporting exactly what came back rather than wearing a type whose code the
 * platform never sent.
 */
export class RunReadError extends AgentError {
  public readonly status?: number;
  public readonly code?: string;
  public readonly detail: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'RunReadError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    Object.setPrototypeOf(this, RunReadError.prototype);
  }
}

/**
 * `404 DEPLOYMENT_NOT_FOUND` — no run has that id.
 *
 * A spawn returns the child run's id in `Spawn.spawn_id`; anything else is a
 * guess. Note that a run row is not immortal: an archived agent takes its runs
 * with it.
 */
export class RunNotFound extends RunReadError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, { status: 404, code: DEPLOYMENT_NOT_FOUND, detail });
    this.name = 'RunNotFound';
    Object.setPrototypeOf(this, RunNotFound.prototype);
  }
}

/**
 * `403 DEPLOYMENT_ACCESS_DENIED` — the run belongs to another account.
 *
 * Distinct from {@link RunNotFound} because the platform distinguishes them,
 * and the two are different problems: an id that does not exist is a bug in
 * what you passed, an id you may not read is a bug in whose key you used.
 */
export class RunAccessDenied extends RunReadError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, { status: 403, code: DEPLOYMENT_ACCESS_DENIED, detail });
    this.name = 'RunAccessDenied';
    Object.setPrototypeOf(this, RunAccessDenied.prototype);
  }
}

/**
 * `422 DEPLOYMENT_WAIT_TIMEOUT_INVALID` — the server rejected the
 * `timeout_seconds` it was sent.
 *
 * {@link wait} checks the same bound before it sends anything, and throws an
 * `AgentError` when the CALLER is out of range — that is a bad argument, not a
 * refusal, and it costs no round trip. This type is for the case that check did
 * not catch: the server's bound moved. Kept as a named type so that day arrives
 * as something to read rather than as a bare 422 the helper had no shape for.
 */
export class WaitTimeoutInvalid extends RunReadError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, {
      status: 422,
      code: DEPLOYMENT_WAIT_TIMEOUT_INVALID,
      detail,
    });
    this.name = 'WaitTimeoutInvalid';
    Object.setPrototypeOf(this, WaitTimeoutInvalid.prototype);
  }
}
