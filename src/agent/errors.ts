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
 * (413 RUN_PAYLOAD_TOO_LARGE), the account's line of waiting runs is full
 * (429 AGENT_RUN_LINE_FULL), and everything else. "Everything else" is any other
 * status AND any other code on those two statuses: the pairing is what selects
 * a type, so a 413 the platform grows for some new reason arrives as a plain
 * SpawnError reporting its own code rather than wearing this one's.
 *
 * READING A RUN BACK has its own small family below, under `RunReadError`, and
 * it follows exactly the same rule. It is a SEPARATE family from `SpawnError`
 * rather than a widening of it, because the two calls fail at different things:
 * a spawn is refused for what you asked to start, a read for what you asked to
 * see. `ResultTooLarge` sits outside both — it is thrown before anything leaves
 * the machine.
 *
 * CANCELLING A RUN has a third family, under `RunCancelError`, with the same
 * rule. Two of its refusals are the read family's own types, because they are
 * the same two problems: `RunNotFound` (no run has that id) and
 * `RunAccessDenied` (the run is not the caller's to touch). Code that catches
 * only `RunCancelError` therefore misses those two; catch `AgentError` to see
 * every failure of the module. `NotAServiceRun` is thrown before anything leaves
 * the machine, by `serviceRun`.
 *
 * LOOKING A PEER UP is a third family, under `PeerLookupError`, with the same
 * rule again: the status and the code together select a subclass
 * (`PeerNotFound`, `PeerHasNoUrl`) and anything else arrives as the base
 * reporting what came back. Reaching the peer itself, once it is found, throws
 * nothing of the platform's: the peer is another service, and what it answers
 * is returned as it came (see `callAgent`).
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
export const AGENT_RUN_LINE_FULL = 'AGENT_RUN_LINE_FULL';

/**
 * The two headers the platform sets on the call to a service's
 * `POST /aetherfy/run`: the run's id and the run's own key. ONE definition each:
 * `serviceRun` reads them and `NotAServiceRun` names them.
 */
export const RUN_ID_HEADER = 'X-Aetherfy-Run';
export const RUN_KEY_HEADER = 'X-Aetherfy-Run-Key';

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
  /**
   * The seconds the control plane's `Retry-After` header asked to wait, or
   * undefined. A spawn repeated before that time is refused again; this helper
   * never retries a spawn itself.
   */
  public readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
      retryAfter?: number;
    } = {}
  ) {
    super(message);
    this.name = 'SpawnError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    this.retryAfter = options.retryAfter;
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
 * `429 AGENT_RUN_LINE_FULL` — the account's line of waiting runs is full.
 *
 * A run started while the account is at its in-flight limit does not fail: it
 * waits in the account's line, and the spawn is accepted with status
 * `waiting`. This is thrown only when the line itself already holds the most
 * runs the plan allows, so there is nowhere left to wait.
 *
 * THE LIMITS ARE THE ACCOUNT'S, NOT THE AGENT'S, and the plan sets them.
 * `waitingCount` runs are in the line now, of at most `maxWaitingRuns`;
 * `inFlightCount` runs are executing, of at most `maxInFlightRuns`. `limit`
 * names WHICH plan limit was hit (`"max_waiting_runs"` today) and is read from
 * the envelope rather than assumed, so a second named limit reaching this
 * status arrives intact. Any of them is `null` when the envelope does not carry
 * it, so a caller building a message from them must not assume a number.
 *
 * NOTHING IS RETRIED FOR YOU. This refusal comes with no `Retry-After`;
 * `retryAfter` is the seconds that header asks to wait, and is undefined
 * whenever it is absent. Spawn again once runs have left the line, and decide
 * for yourself how long to wait.
 */
export class RunLineFull extends SpawnError {
  public readonly waitingCount: number | null;
  public readonly maxWaitingRuns: number | null;
  public readonly inFlightCount: number | null;
  public readonly maxInFlightRuns: number | null;
  public readonly limit: string | null;

  constructor(
    message: string,
    options: {
      waitingCount?: number | null;
      maxWaitingRuns?: number | null;
      inFlightCount?: number | null;
      maxInFlightRuns?: number | null;
      limit?: string | null;
      detail?: Record<string, unknown>;
      retryAfter?: number;
    } = {}
  ) {
    super(message, {
      status: 429,
      code: AGENT_RUN_LINE_FULL,
      detail: options.detail,
      retryAfter: options.retryAfter,
    });
    this.name = 'RunLineFull';
    // Absent and explicitly-null both surface as null, so the two languages
    // agree: Python collapses them to None and a caller porting a task between
    // them should not find one of them reading `undefined`.
    this.waitingCount = options.waitingCount ?? null;
    this.maxWaitingRuns = options.maxWaitingRuns ?? null;
    this.inFlightCount = options.inFlightCount ?? null;
    this.maxInFlightRuns = options.maxInFlightRuns ?? null;
    this.limit = options.limit ?? null;
    Object.setPrototypeOf(this, RunLineFull.prototype);
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
 * The control-plane error codes the run-reading and run-cancelling calls give a
 * type of their own. ONE definition each, for the same reason as the two above:
 * the code both SELECTS the type and is STAMPED on it, and two literals could
 * disagree.
 *
 * The first two are the deployment read's existing contract, and the /wait
 * route answers with them identically by construction — one loader serves both
 * routes upstream, so a caller need not know which one it called. The cancel
 * route answers with the same two.
 */
export const DEPLOYMENT_NOT_FOUND = 'DEPLOYMENT_NOT_FOUND';
export const DEPLOYMENT_ACCESS_DENIED = 'DEPLOYMENT_ACCESS_DENIED';
export const DEPLOYMENT_WAIT_TIMEOUT_INVALID =
  'DEPLOYMENT_WAIT_TIMEOUT_INVALID';
/** A cancel of an id that is a release, not a run. */
export const DEPLOYMENT_NOT_A_RUN = 'DEPLOYMENT_NOT_A_RUN';
/**
 * An agent's key used on a run outside what it may touch. A cancel of a run
 * that is not below the key's own run is refused with it.
 */
export const AUTH_AGENT_KEY_OUT_OF_SCOPE = 'AUTH_AGENT_KEY_OUT_OF_SCOPE';

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
  /**
   * The seconds the control plane's `Retry-After` header asked to wait, or
   * undefined. This helper never retries a read itself.
   */
  public readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
      retryAfter?: number;
    } = {}
  ) {
    super(message);
    this.name = 'RunReadError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    this.retryAfter = options.retryAfter;
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
 * The control plane will not let this key touch the run.
 *
 * Two codes arrive as this type, and `code` is the one that came, the thing to
 * tell them apart by:
 *
 * - `403 DEPLOYMENT_ACCESS_DENIED`, the run belongs to another account, from a
 *   read or a cancel;
 * - `403 AUTH_AGENT_KEY_OUT_OF_SCOPE`, from {@link cancel} ONLY: an agent's key
 *   may cancel just the runs below its own run.
 *
 * A READ is different. An agent's own key reading a run outside its run tree is
 * `403 AUTH_AGENT_KEY_OUT_OF_SCOPE` too, but it arrives as a plain
 * {@link RunReadError} carrying that `code`: what the key may read, not whose
 * run it is.
 *
 * Distinct from {@link RunNotFound} because the platform distinguishes them,
 * and the two are different problems: an id that does not exist is a bug in
 * what you passed, an id you may not touch is a bug in whose key you used.
 */
export class RunAccessDenied extends RunReadError {
  constructor(
    message: string,
    detail?: Record<string, unknown>,
    code: string = DEPLOYMENT_ACCESS_DENIED
  ) {
    super(message, { status: 403, code, detail });
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

/**
 * The control plane refused to cancel a run, for a reason with no type of its
 * own.
 *
 * `code` is the platform's stable error code (`detail.code` in the
 * control-plane envelope) and is the thing to branch on; the message is prose
 * that may be reworded at any time.
 *
 * Same discipline as {@link SpawnError}: the STATUS AND THE CODE together
 * select a subclass, and an unrecognised pairing arrives as this class
 * reporting exactly what came back. A run that had already ended is not a
 * refusal at all: the cancel answers 200 with outcome `already_finished`.
 *
 * The two refusals every run call shares are NOT subclasses of this: an id no
 * run has is {@link RunNotFound}, and a run this key may not cancel is
 * {@link RunAccessDenied}. Catch {@link AgentError} to see all of them.
 */
export class RunCancelError extends AgentError {
  public readonly status?: number;
  public readonly code?: string;
  public readonly detail: Record<string, unknown>;
  /**
   * The seconds the control plane's `Retry-After` header asked to wait, or
   * undefined. This helper never retries a cancel itself.
   */
  public readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
      retryAfter?: number;
    } = {}
  ) {
    super(message);
    this.name = 'RunCancelError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    this.retryAfter = options.retryAfter;
    Object.setPrototypeOf(this, RunCancelError.prototype);
  }
}

/**
 * `409 DEPLOYMENT_NOT_A_RUN` — the id names a release, not a run.
 *
 * A release is cancelled with the CLI's `afy cancel <agent>`; this call cancels
 * runs. `Spawn.spawn_id` is always a run's id.
 */
export class NotARun extends RunCancelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, { status: 409, code: DEPLOYMENT_NOT_A_RUN, detail });
    this.name = 'NotARun';
    Object.setPrototypeOf(this, NotARun.prototype);
  }
}

/**
 * {@link serviceRun} was given headers that carry no run id and key.
 *
 * `serviceRun` is for the handler of `POST /aetherfy/run` ONLY. The platform
 * sets `X-Aetherfy-Run` and `X-Aetherfy-Run-Key` on that one call and removes
 * both from every public request, so headers without them belong to an ordinary
 * request, or to a service deployed before a service run had a key of its own,
 * which has to be deployed again. `missing` names the headers that were not
 * there.
 */
export class NotAServiceRun extends AgentError {
  public readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `serviceRun() is for the handler of POST /aetherfy/run only: the platform ` +
        `sets ${RUN_ID_HEADER} and ${RUN_KEY_HEADER} on that call, and these ` +
        `headers lack ${missing.join(' and ')}. A public request carries ` +
        'neither; a service deployed before a service run had a key of its own ' +
        'sends no key and has to be deployed again.'
    );
    this.name = 'NotAServiceRun';
    this.missing = [...missing];
    Object.setPrototypeOf(this, NotAServiceRun.prototype);
  }
}

/**
 * The two control-plane error codes a peer lookup gives a type of its own. ONE
 * definition each, for the same reason as the codes above: the code both
 * SELECTS the type and is STAMPED on it.
 */
export const AGENT_NOT_FOUND = 'AGENT_NOT_FOUND';
export const PEER_HAS_NO_URL = 'PEER_HAS_NO_URL';

/**
 * The code the edge in front of `*.aetherfy.dev` answers a RETIRED address
 * with, beside `AGENT_NOT_FOUND` (which it uses for an address that never
 * existed or was deleted). Not a lookup error: it arrives in the body of a
 * peer's response, never from the control plane, and `callAgent` reads it to
 * decide whether to look the peer up again.
 */
export const AGENT_NOT_REACHABLE = 'AGENT_NOT_REACHABLE';

/**
 * The control plane did not hand over a peer's address.
 *
 * `code` is the platform's stable error code (`detail.code` in the
 * control-plane envelope) and is the thing to branch on; the message is prose
 * that may be reworded at any time.
 *
 * Same discipline as {@link SpawnError}: the STATUS AND THE CODE together
 * select a subclass, and an unrecognised pairing arrives as this class
 * reporting exactly what came back — among them
 * `403 AUTH_AGENT_KEY_OUT_OF_SCOPE`, when this machine's own key may not look
 * peers up.
 */
export class PeerLookupError extends AgentError {
  public readonly status?: number;
  public readonly code?: string;
  public readonly detail: Record<string, unknown>;
  /**
   * The seconds the control plane's `Retry-After` header asked to wait, or
   * undefined. This helper never retries a lookup itself.
   */
  public readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      detail?: Record<string, unknown>;
      retryAfter?: number;
    } = {}
  ) {
    super(message);
    this.name = 'PeerLookupError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail ?? {};
    this.retryAfter = options.retryAfter;
    Object.setPrototypeOf(this, PeerLookupError.prototype);
  }
}

/**
 * `404 AGENT_NOT_FOUND` — this agent's own workspace holds no agent of that
 * name.
 *
 * Peers are the agents of the caller's own workspace, found by the name the
 * agent has there; another workspace's agent is not a peer, and neither is a
 * name that was spelled differently when the agent was created.
 */
export class PeerNotFound extends PeerLookupError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, { status: 404, code: AGENT_NOT_FOUND, detail });
    this.name = 'PeerNotFound';
    Object.setPrototypeOf(this, PeerNotFound.prototype);
  }
}

/**
 * `409 PEER_HAS_NO_URL` — the peer exists, but nothing listens for requests on
 * it.
 *
 * A peer that is not reachable by URL cannot be called, whatever else it can
 * do: it is not a service. Start it with {@link spawn} instead, or call a peer
 * that serves HTTP.
 */
export class PeerHasNoUrl extends PeerLookupError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, { status: 409, code: PEER_HAS_NO_URL, detail });
    this.name = 'PeerHasNoUrl';
    Object.setPrototypeOf(this, PeerHasNoUrl.prototype);
  }
}
