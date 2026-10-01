# System Boundaries

## Dependency rule

Rhiz Harness follows one directional dependency principle:

```text
Product / organization integrations
            ↓
Experience / CLI / API
            ↓
Board + Crew + Intelligence modules
            ↓
Portable Kernel contracts
            ↓
Host / provider interfaces
            ↓
Concrete adapters and runtimes
```

A lower layer MUST NOT import an upper layer merely to get convenient state.

## The DSH boundary

DSH is the first Host. The portable core MUST NOT import DSH packages or DSH-specific types.

```text
Rhiz portable core
      ↓ interfaces
Rhiz DSH HostAdapter
      ↓ translation
DSH plugins / sessions / tools / jobs / sandboxes / terminals / subagents
```

A breaking DSH change should normally require edits inside the DSH adapter and its compatibility tests, not Board, WorkContract, Ledger, Verify, Context, or Rules.

## Rhiz Protocol boundary

```text
rhizprotocol
     ↓ consumes
rhiz-harness
```

`rhizprotocol` may provide:

- organization-specific Rules and Rule catalogs;
- private Context sources;
- deployment and repository adapters;
- Graph integrations;
- verification profiles;
- authority policies;
- product-specific plugins.

The portable Rhiz Harness core MUST NOT require any of them.

## Canonical ownership matrix

| Fact | Canonical owner | Other systems may provide |
| --- | --- | --- |
| Work objective and contract | Board / Work stream | observations, amendment proposals |
| Task/Attempt assignment | Board | worker acknowledgements |
| Organizational state | Board projection | runtime/model/process observations |
| Authority | Guard + WorkContract | capability discovery |
| Event history | Ledger | event producers |
| Process/session liveness | Runtime/Host observation | Board projection consumes observation |
| Artifact identity | Artifact/Evidence layer | filesystem/Git/runtime observations |
| Verification result | Verify | worker self-checks as evidence only |
| Acceptance | Board decision | Verify/review recommendations |
| Rule contract and selection semantics | Rules | organization-specific Rule catalogs |
| Context selection | Context module | repository/model/provider inputs and selected Rules |
| Route selection | Router | provider capability/performance evidence |
| Lesson proposal | Refiner | any evidence source |

## Anti-corruption rules

1. Concrete host/provider types stay below portable interfaces.
2. External state enters Rhiz as typed observations or evidence before affecting projections.
3. Provider-specific errors are translated into portable error categories while preserving raw diagnostic references when safe.
4. Provider capabilities are discovered explicitly; unsupported capabilities fail or degrade according to policy rather than being guessed.
5. No adapter may silently grant broader authority than the WorkContract allows.
6. No runtime heartbeat may refresh canonical progress merely because a process exists.
7. No worker completion event may generate acceptance without the required verification/decision path.
8. Organization-specific Rules may enter through the portable Rule contract but MUST NOT become dependencies of the portable core.
9. A Rule marked mechanized must name the mechanism that enforces it; prompt injection alone is never mechanical enforcement.

## Failure boundaries

The system assumes all of the following may fail independently:

- a model request;
- a Worker;
- a local process;
- a Host;
- a terminal/session;
- a sandbox;
- a network call;
- a Git provider;
- CI;
- an external API;
- the UI.

Durable Work and Ledger state must remain reconstructible after those failures.

## Initial module boundaries

### Kernel
Owns portable identifiers, WorkContract, typed Event envelope, capability interfaces, error vocabulary, and compatibility rules.

### Ledger
Owns append/read/replay of durable events and evidence references. It does not decide Work state.

### Board
Projects canonical Work/Task/Attempt state from events and emits explicit decisions/amendments.

### Crew
Coordinates task decomposition, worker assignment, SCOUT/SHIP/REVIEW policy, dependencies, and supervision. Crew does not redefine Board truth.

### Rules
Owns the portable Rule schema and deterministic selection semantics. It does not own an organization's Rule contents and does not grant authority. Mechanized Rules name enforcement owned by Guard or another deterministic mechanism. Selected injected/graded Rules enter execution through Context.

### Context
Selects and records ContextPacks. It may use repository maps, Graph data, history, selected Rules, and upstream provider constraints.

### Guard
Evaluates AuthorityPolicy and enforces mechanizable boundaries at capability seams.

### Verify
Evaluates claims against AcceptanceCriteria and EvidenceRequirements. It emits verification events and evidence.

### Router
Chooses among eligible execution strategies using measured evidence. Routing recommendations never bypass Guard or acceptance policy.

### Refiner
Turns evidence into proposed Lessons and promotion candidates, including proposed Rule changes. Refiner proposals are not self-authorizing mutations.

### Runtime
Owns process/session execution and observations. Concrete runtime implementations remain replaceable.

### Experience
CLI, API, terminal, desktop/web, Board visualizations, diffs, notifications, and One Less Action ergonomics consume the same portable state rather than implementing parallel semantics.
