# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `gantry()` pipeline around `tools/call` for MCP SDK v2 and v1, with `g.tool()`, `g.wrapExisting()` and `gantry.recommended()`.
- Call context with principal, RFC 8785 canonical `argsHash`, combined abort signal, elicitation, store, clock, events and per-call state.
- Error contract: refusals as tool results with `structuredContent.gantry.code`.
- Modules: `audit`, `rateLimit`, `timeout`, `idempotency`, `approval` (elicit, token, out-of-band), `annotations`, `outputLimit`.
- Stores: `memoryStore`, `redisStore` (ioredis, node-redis), `mongoStore`, with a shared contract suite.
- Testing: `gantryTest()` in-process harness, fake clock, client profiles, Vitest/Jest matchers.
- Examples: quickstart, CRM server, Telegram out-of-band approval.
- Docs, SECURITY.md threat model, pipeline benchmark.
