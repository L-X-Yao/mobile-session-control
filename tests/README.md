# Reproducible offline tests

Contents:

- Fake-provider fixtures.
- Loopback-only integration tests.
- Fresh isolated HOME/config/state per test run.
- No real provider, credential, phone, ADB or production deployment.

Run all offline checks from the repository root:

```sh
npm test
```

Existing tests:

- CLI provider, launcher-guard, allowlist-proxy and M1 tests:
  `packages/cli/test/`.
