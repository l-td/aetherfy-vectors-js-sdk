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
