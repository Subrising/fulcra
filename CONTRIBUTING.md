# Contributing to Fulcra

Fulcra is maintained in [Subrising/fulcra](https://github.com/Subrising/fulcra). Bring bug reports, documentation improvements and focused changes here; the upstream Paseo project has its own maintainers and contribution policy.

## Find a useful change

Search [existing issues](https://github.com/Subrising/fulcra/issues) before reporting a bug or proposing a feature. Describe the user workflow, current behavior and expected outcome. A small reproducible problem is easier to assess than a speculative redesign.

For a bug, include the Fulcra release/source revision, platform, reproduction steps and relevant **sanitised** output. Crop screenshots to clean demo content. Remove credentials, pairing offers/QR codes, private account names, session/device IDs, machine paths and image metadata before posting. Security-sensitive reports follow [SECURITY.md](SECURITY.md), not a public bug thread.

## Work from public main

Create a branch from current public `main`, keep the change focused and open a pull request in this repository. Do not import private development history or operational evidence. Preserve the root [LICENSE](LICENSE), [NOTICE](NOTICE) and applicable third-party notices.

See [Build, launch & pair](docs/getting-started.md) and [Development](docs/development.md) for the actual source commands. Packages retain `@getpaseo/*` technical names and compatibility identities; branding work must not rename runtime homes, credentials or protocol contracts.

## Verify the behavior you change

Run the smallest checks that can expose a failure in your change, and include the command and actual outcome in your PR. Use focused existing suites rather than a full local monorepo test run. CI runs on GitHub-hosted runners; repository billing/availability can affect whether it starts.

For UI work, show the actual affected flow with clean screenshots or a short recording. Do not substitute a mockup or an AI-generated app image for product evidence. For docs-only changes, check relative links, diagrams and rendered layout. For behavioral fixes, explain the trigger and the before/after result. Preserve failures and limits rather than presenting unavailable checks as passes.

## Extensions and boundaries

Read the local [plugin guide](docs/plugins.md) and [SDK quickstart](public-docs/sdk/quickstart.md) before extending the host or client. Plugins run trusted code; installing a skill, naming a role or adding a UI does not grant new permissions. Protocol changes must remain compatible with supported clients; see [protocol compatibility](docs/protocol-compatibility.md).

Do not include provider logins, private account state, service grants or live installation changes in a source PR. Do not run deployment/publish workflows as part of an ordinary test. Workflow runtime behavior, secrets and permissions require their own deliberate scope; changing a name or link is not that authorization.

## Community

Be specific, courteous and open to correction. See the [Code of Conduct](CODE_OF_CONDUCT.md). Maintainers decide product scope and merges; an issue or proposed implementation is not a commitment to ship it.
