# Contributing to Gantry

Thanks for helping. Gantry sits in the security path of MCP servers, so the bar is: small, tested, documented changes.

## Setup

```bash
git clone https://github.com/gorilli-team/gantry-mcp.git
cd gantry-mcp
npm ci
npm test
```

Node 22 or later.

## Before you open a pull request

```bash
npm run lint        # Biome, warnings fail
npm run typecheck
npm run test:coverage   # 90% lines/statements/functions, 85% branches
npm run build
```

- **One change per pull request**, with tests. Bug fixes start with a failing test.
- **Fail closed.** A module that cannot do its job (store down, missing capability) refuses the call. Never allow by default.
- **Refusals are results.** Return `gantryError(code, text)` with text written for the model: what happened and what to do next.
- **No runtime dependencies.** The MCP SDK is a peer dependency; anything else needs a strong case.
- **Docs.** New options go in the module's page under `docs/modules/`, including its "when you don't need this" section.
- **Commits** follow `type(area): message`, for example `fix(approval): ...` or `feat(rate-limit): ...`.

## Adding a store

Implement `Store` and run `test/stores/contract.ts` against it. Operations must be atomic per key.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
