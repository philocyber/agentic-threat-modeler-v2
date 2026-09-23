# Contributing to Argus

Argus is a local proof of concept for human-reviewed threat modeling. Feedback on the **quality and clarity of findings** is as valuable as code: tell us when a scenario is hard to understand, a source does not support a claim, a control is misrepresented, or the next review action is unclear.

Open an issue with a small, reproducible example and the behavior you expected. Proposals for the review workflow, documentation, accessibility, installation, and provider support are welcome. Use synthetic or public examples only. Never attach real architecture documents, credentials, reports, databases, or provider logs containing private data.

Before changing code, read the [local setup](docs/getting-started/local.md) and repository instructions in [AGENTS.md](AGENTS.md). Use Node 22.23.2 and pnpm 11.1.2, then install dependencies with `pnpm install --frozen-lockfile`. For changes that affect behavior, add a focused regression check and run the relevant tests, `pnpm typecheck`, and `pnpm check:docs`. Run `pnpm check` and `pnpm build` before proposing a release. Tests against real inference providers are optional, require your own credentials, and may incur charges.

Keep pull requests focused. Explain the user-facing change, the evidence behind it, the commands you ran, and any limitation that remains. Update current documentation in `docs/` and summarize material product changes in `CHANGELOG.md`. Do not copy agent transcripts or real run data into fixtures or documentation.

Contributions to this V2 repository are distributed under its [source-available license](LICENSE), subject to the required [notice](NOTICE). By submitting a contribution, confirm that you have the rights needed to contribute it under those terms. The [earlier Python repository](https://github.com/philocyber/agent-threat-modeler) has separate MIT terms.

For source packages, run `pnpm package:source /path/to/new/directory` and inspect the manifest and secret scan before sharing the package. The [distribution guide](docs/development/distribution.md) explains what must remain local.
