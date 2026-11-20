# CLI tests

Run all offline checks from the repository root:

```sh
npm test
```

Contents:

- provider schema, launcher guard, allowlist proxy, M1 worker, session
  manager, session host, relay state and web-client tests;
- fake-provider and fake-session-host fixtures;
- fresh isolated HOME/config/state per test run.

No real provider, credential, phone, ADB or production deployment is used.
