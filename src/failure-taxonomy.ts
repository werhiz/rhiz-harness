export const FAILURE_TAXONOMY = [
  "wrong-understanding",
  "missing-context",
  "too-much-context",
  "bad-routing",
  "worker-capability",
  "authority-error",
  "coordination-error",
  "concurrency-conflict",
  "implementation-error",
  "verification-gap",
  "false-verification",
  "runtime-failure",
  "dependency-failure",
  "environment-drift",
  "process-stall",
  "recovery-failure",
  "human-friction",
  "architecture-confusion",
  "repeated-mistake",
] as const;
export type FailureTaxonomy = typeof FAILURE_TAXONOMY[number];

