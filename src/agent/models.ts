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
 * An accepted spawn: the control plane recorded the run and queued its deploy.
 *
 * Acceptance is not execution. `status` is the run's INITIAL status, and a
 * spawned run that lands on an agent already busy fails as busy rather than
 * queueing — Aetherfy never queues a run behind another.
 */
export interface Spawn {
  spawn_id: string;
  job_id: string;
  child_agent_id: string;
  region: string;
  status: string;
  /** Null when both parent and child are workspaceless. */
  workspace: string | null;
  estimated_start?: string;
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
 * `state` IS THE ONE TO READ AFTER A WAIT. A wait that times out returns the
 * run exactly as it stands, which is not an error — `active` on a run means it
 * is executing right now, and the terminal states are `completed` and `failed`.
 * There is deliberately no `is_finished` here: the set of in-flight states
 * belongs to the platform, and a second copy of it in this package would be a
 * copy that could disagree.
 *
 * `result` is null both for a run that returned nothing and for one whose
 * result was refused — `result_error` is what tells those apart, and
 * `has_result` is the platform's own answer to "did this run answer at all". A
 * refused result is not a result, so `has_result` is false whenever
 * `result_error` is set.
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
  /** Everything the control plane sent, unmodified. */
  raw: Record<string, unknown>;
}
