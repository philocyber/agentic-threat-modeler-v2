/** Contract versions included in checkpoint compatibility. Changing these
 * invalidates resume against older checkpoints without rewriting them. */
export const EVIDENCE_CONTRACT_VERSION = 3
export const ADAPTER_CONTRACT_VERSION = 'structured-v3-accounted-calls'
export const PIPELINE_WORKER_CODE_VERSION = '2026-09-17-provider-debate-v35'
export const ANALYSIS_RULES_VERSION = 'common-analysis-2026-09-15'

export const WORKER_RECOVERY_ACTION =
  'Stop the live pipeline-worker process and start the current checkout with pnpm pipeline:worker (or pnpm dev). Do not enqueue new runs until health reports a compatible worker.'
