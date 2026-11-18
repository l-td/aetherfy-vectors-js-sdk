/**
 * Value types returned by the Aetherfy Agent helper.
 *
 * SNAKE_CASE, DELIBERATELY, and for two different reasons that land in the
 * same place. `Spawn` is a response body this SDK returns essentially verbatim
 * — the same rule that made `Collection.points_count` and `UsageStats`
 * snake_case after both shipped as camelCase lies about fields no response
 * ever carried. `MachineShape` is not a body, but it mirrors
 * `AETHERFY_MEMORY_MB` and its siblings one-for-one, and the Python helper
 * spells these fields the same way: the two helpers are one API in two
 * languages, so a reader porting a task between them should not have to
 * re-learn the field names.
 *
 * This SDK's camelCase vocabulary is OUTBOUND only.
 */

/**
 * The machine this run is executing on.
 *
 * `vcpus` is the shared vCPU count the platform derives from the agent's
 * memory step — size an in-machine pool from it. `memory_mb` is the memory the
 * agent was deployed with, and the limit that ends the whole run if the
 * process crosses it.
 */
export interface MachineShape {
  vcpus: number;
  memory_mb: number;
  region: string;
}

/**
 * An accepted spawn: the control plane recorded the run.
 *
 * Acceptance is not execution. `status` is the run's INITIAL status, and there
 * are two:
 *
 * - `'queued'`: the run goes straight to a machine.
 * - `'waiting'`: the account is at its in-flight limit, so the run waits in the
 *   account's line, with no machine and nothing billed, until a slot frees.
 *   `position` is its place there, `1` being next. A run that is waiting has no
 *   `job_id` yet.
 *
 * `wait` includes the time in the line, so a caller that waits on a run needs no
 * other handling for `waiting`. A spawn is refused with `RunLineFull` only when
 * the line itself is full.
 *
 * `position` is `null` unless the run is waiting. `raw` is the whole response
 * body, unmodified, like {@link Run.raw}.
 */
export interface Spawn {
  spawn_id: string;
  job_id: string | null;
  child_agent_id: string;
  region: string;
  status: string;
  /** The spawned agent's own workspace, by name. Every agent lives in one. */
  workspace: string;
  estimated_start?: string;
  position: number | null;
  /** Everything the control plane sent, unmodified. */
  raw: Record<string, unknown>;
}

/**
 * One run, read back from the control plane.
 *
 * THE RUN ROW IS THE RECORD. A run's answer is not delivered anywhere — it is
 * stored on the run and read from it, so a parent hears from a child in another
 * region with no side channel and no shared storage between them.
 *
 * Only the fields a caller of {@link result} or {@link wait} reads are named
 * here. The response carries a deployment object with a good deal more on it
 * (regions, versions, rollback and cancellation flags), all of which is
 * deploy-shaped rather than run-shaped; it is kept verbatim in `raw` rather
 * than re-declared field by field in a place that would rot the first time the
 * platform adds one.
 *
 * `state` IS THE ONE TO READ AFTER A WAIT. A run is `waiting` while it waits in
 * the account's line (no machine, nothing billed, and `raw.position` is its
 * place there, 1 being next), `active` while it is executing, and it ends
 * `completed`, `failed` or `cancelled`. A wait that times out returns the run
 * exactly as it stands, which is not an error: `waiting` and `active` both mean
 * call again. There is deliberately no `is_finished` here, and no union of the
 * states: the set belongs to the platform, and a second copy of it in this
 * package would be a copy that could disagree.
 *
 * `result` is null both for a run that returned nothing and for one whose
 * result was refused — `result_error` is what tells those apart, and
 * `has_result` is the platform's own answer to "did this run answer at all". A
 * refused result is not a result, so `has_result` is false whenever
 * `result_error` is set.
 *
 * `failure_code` is why a FAILED run failed, as the platform's code, beside
 * `error_message`, its sentence: the value to switch on (the code is the
 * contract, the sentence is prose). Null for a run that did not fail, and for
 * one that failed before the platform recorded codes. A `cancelled` run carries
 * none: why it was stopped is `raw.cancellation_reason`.
 */
export interface Run {
  id: string;
  agent_id: string;
  state: string;
  result: unknown;
  result_error: string | null;
  has_result: boolean;
  is_ephemeral: boolean;
  error_message: string | null;
  failure_code: string | null;
  /** Everything the control plane sent, unmodified. */
  raw: Record<string, unknown>;
}

/**
 * What cancelling a run answered.
 *
 * `outcome` says what the call did, and is one of:
 *
 * - `'cancelled'`: the run is cancelled now (it was waiting, or had not started).
 * - `'stopping'`: the run was executing and is being stopped; it ends
 *   `cancelled`.
 * - `'already_finished'`: the run had ended before the call. Not an error:
 *   nothing was cancelled.
 *
 * `run` is the run as the call left it. `cancelled_count` is how many runs this
 * call cancelled, the runs started below it (its descendants) included.
 * `message` is prose for a person and may be reworded at any time; branch on
 * `outcome`.
 */
export interface Cancellation {
  run: Run;
  outcome: string;
  message: string;
  cancelled_count: number;
}

/**
 * What a peer answered to {@link callAgent}.
 *
 * Small on purpose: the peer is another service and its answer is its own, so
 * this carries the three things every answer has and no more. `status` is the
 * HTTP status exactly as the peer sent it — an error status is a return, not a
 * throw, because only the caller knows what a 404 from that peer means.
 * `headers` has lower-case names. `text` is the body decoded as UTF-8, with
 * undecodable bytes replaced. The Python helper's `PeerResponse` has the same
 * three fields and the same `json()`.
 */
export interface PeerResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /**
   * The body parsed as JSON.
   *
   * @throws {SyntaxError} The body is not JSON (an empty body included).
   */
  json(): unknown;
}
