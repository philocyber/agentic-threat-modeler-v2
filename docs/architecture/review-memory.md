# System review memory

Reviewer decisions can inform later scans of the **same system**. This is a bounded historical context channel, not a new source of automatic verdicts.

## Scope and eligibility

- A project can contain several systems. A decision from one system is never selected for another solely because they share a project.
- The system is identified by its persisted `systemId`, not by a title or a similar application name. A fresh run should reuse the existing system record to receive its history.
- A source run must be `completed`, active, and have a persisted, reasoned Confirm or Reject decision for **every** finding. Partial, failed, archived, zero-finding, partly reviewed, and incomplete legacy runs do not contribute.
- The current run is excluded. A changed review status or rationale affects future scans immediately because decisions are read from the workspace database. No Chroma reindex or manual output selection is required.
- The lookup considers the 100 most recent eligible runs. The prompt includes at most five recent confirmed and five recent rejected examples. Retrieval can select a few relevant same-system examples by query. Both channels carry the source run ID; the RAG channel also records it in passage metadata.

Local SQLite workspaces keep projects separate. In PostgreSQL mode, existing actor ownership checks still apply in addition to the system filter.

## Evidence priority and behavior

1. **Current run:** architecture, original source quotations, observed or unknown controls, and new analysis establish the finding's present applicability.
2. **Technical and corporate retrieval:** passages support mechanisms and scoped organizational facts. A policy is not proof that a control operates.
3. **Prior reviewer decisions:** same-system verdicts and rationale suggest what to check. A past rejection may no longer apply after a system change; a past confirmation may no longer be reproducible.

Prior decisions never automatically confirm, reject, suppress, score, or change the persisted review state of a new finding. They cannot replace a current architecture anchor. Reviewer notes are treated as untrusted historical text, not instructions. The application does not assert that this context improves finding quality without controlled evaluation.

## Shared project facts

Put reusable facts such as API authentication patterns, WAF deployment, or guardrail operation into a reviewed corporate knowledge source. Record the affected systems, environment, effective date, evidence, and unknowns. Such a source is retrieved through the corporate knowledge channel and must still be checked against the current system. Reviewer decisions are never automatically promoted to project-wide facts.

## Operation and inspection

Review each finding in the Findings workspace and provide a rationale. The `GET /api/v1/projects/learning?systemId=<id>` response reports how many eligible examples a scan of that system can use; aggregate project review counts remain separate. The pipeline emits a `reviewer_learning_applied` audit event when examples enter its prompt. Retrieved reviewer passages are visible in the RAG trace with their source run ID. A scan with RAG disabled can still receive same-system examples through the prompt path.

Reusing a prior run's input is a separate workflow. The review memory uses current stored decisions automatically; no prior output needs to be chosen or merged into the new architecture.
