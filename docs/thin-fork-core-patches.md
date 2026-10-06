# Thin fork core patches

Fulcra owns its fork. Take maintenance from Paseo; do not submit Fulcra features or extension proposals upstream. New product policy belongs in bundled plugins. Keep core changes at the named seams below; an ID, label, project, worker or task record never confers authority.

| Patch                  | Core responsibility                                                          | Policy boundary                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branding`             | Display constants, bundled assets, packaged defaults                         | Preserve existing wire IDs, URI aliases and credential/home paths until an explicit compatible migration.                                         |
| `trusted-bundle`       | Immutable bundled identity and verified host loading                         | A host-selected ID routes only to a physically verified bundle and its current runtime. It does not grant owner permissions.                      |
| `plugin-sdk`           | Native update/cancel, notification, credential and replayable-event adapters | Retain original principals, bounded payloads, single-use attempts and delivery lifetimes; organisation/report/receipt policy stays in the plugin. |
| `admission-veto`       | Synchronous pre-effect hook dispatch                                         | Preserve all five mandatory hooks, known observers, original operation identities and refusal on async/unknown input.                             |
| `pairing-device-proof` | Signed invitation, native device proof, immutable daemon-key pin             | Confirmation UI cannot replace a stored daemon key or turn a label into a grant.                                                                  |
| `credentials`          | Native secret store/OAuth proxy and transport admission                      | Keep actual account/credential origins and write fences; roster, selection and usage presentation are plugin policy.                              |

Use `// FULCRA(<patch>)` at an owned extension seam. Existing organisation, receipts, report-up, hierarchy, account presentation and automation code still in core is extraction debt, not a seventh blanket patch. Move each through a complete tested plugin boundary; do not delete journal, pin, parent, resume or permission guarantees to reduce a diff.

## Current source slice

Base: maintenance `e4f927d5e634a27345b15dd183315a2266b99c38`.

Stable intake: upstream v0.10.2 `919c737c1948c5a16220307403a82e90d3e27ea0` to official v0.10.3 `b4af508e2a9e5a34a8b0ffb8dfaff6fd679da6c7` (four commits). The maintenance graph's actual merge base is `81865852011df86aa0ad0ae411cb2f5e4078153f`; v0.10.2 content was carried without that tag's ancestry. Apply the exact four-commit delta. This is a source integration, not a claim that the missing ancestry was merged. The preserved failed broad-merge worktree is outside the candidate. The existing upstream watcher is retained once; its ancestry-based intake still needs the recorded-base reconciliation before automated future intake can skip this source-applied tag.

The delta brings host confirmation and stacked native modal behavior. Fulcra keeps V3 invitation parsing, full fingerprints, immutable saved pins, one native device claim per activation, multi-Mac offer bundles and explicit repair-host selection. Legacy unsigned/V2 pairing is not restored. A cancelled question causes no claim, probe or persisted host. Only in-repo workspace version metadata changes from 0.10.2 to 0.10.3; external package resolutions/integrities, patches and lifecycle scripts remain unchanged. Product release labels remain the delivery owner's decision.

The first extracted boundary is configured native controller routing. `PaseoDaemonConfig.bundledControllerPluginId` is an embedding-host startup input, outside persisted config and the wire. Trusted loading still checks the declared manifest ID, owned canonical bundle/entry, registered V1.1 hooks and runtime instance. Management and controller service sockets use the selected identity through the original owner/principal/epoch checks. The client scratch adapter accepts a routing ID without conferring authority. Legacy app entry aliases share one protocol constant; non-default app packaging/navigation is not yet qualified. No wire schema or home/credential path is renamed.

Source is awaiting the reserved Book focused checks and current semantic compiler. The shared delivery owner carries formatter results, source repairs, integrated review and installation. Source assembly alone is not installed acceptance.

## Beta qualification stays separate

Official v0.11.0-beta.3 is `6166a7aca5e3184e8ab505caad28f6a595816414`. It is not an input to the stable candidate. See [the plugin qualification](paseo-plugin-qualification.md) before considering a beta migration.
