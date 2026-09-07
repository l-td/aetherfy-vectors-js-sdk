/**
 * Errors for the Aetherfy Agent helper.
 *
 * Extends `AetherfyVectorsError` so one `catch` around agent code sees
 * vector-db errors and agent-runtime errors alike, and so `instanceof
 * AetherfyVectorsError` still matches. Mirrors `src/memory/errors.ts`,
 * including the prototype re-set after `super()` that ES5-target Error
 * subclassing requires — without it `instanceof` breaks for every subclass.
 *
 * Only three spawn outcomes are worth telling apart, and they are the three
 * the control plane distinguishes: the payload was too big (413), too many
 * runs are already in flight (429), and everything else.
 */

import { AetherfyVectorsError } from '../exceptions';

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
 */
export class NotRunningOnAgent extends AgentError {
  constructor(
    public readonly variable: string,
    purpose: string
  ) {
    super(
      `${variable} is not set, so ${purpose} cannot be read. This helper is ` +
        `for code running on an Aetherfy agent machine; the platform sets ` +
        `${variable} before your entrypoint starts.`
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
      code: 'RUN_PAYLOAD_TOO_LARGE',
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
      code: 'AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED',
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
