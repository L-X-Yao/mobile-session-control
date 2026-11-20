# Open-source boundary

## Public candidates

Source code, sanitized examples, architecture and security documentation, fake-provider fixtures and reproducible offline tests may be published after review.

## Private material

Credentials, API keys, pairing tokens, Tailscale material, Android signing keys, real session histories, provider responses containing private prompts, runtime databases, backups, device identifiers, raw logs, evidence bundles and personal filesystem paths remain outside this repository.

Ignoring a file in Git is not sufficient by itself. Every imported source tree must be scanned before its first commit, and Git history must not contain private material.

## Release gates

1. Identify upstream provenance and preserve all required LICENSE and NOTICE files.
2. Select a project license only after dependency and derivative-work review.
3. Keep the separately licensed Claude Agent SDK and Claude executable as external dependencies. Do not commit SDK packages, binaries, extracted code or runtime bundles containing them without explicit redistribution rights.
4. Complete a secret, privacy and personal-path scan of every candidate file.
5. Provide a loopback-only fake-provider quick start that requires no real account.
6. Document the security model, permission behavior and Stop semantics without overstating them.
7. Pass the DeepSeek fresh offline vertical slice before a `0.1.0` release.
8. Keep production, real-phone, 24-hour reliability and migration claims limited to actual evidence.

No public repository, release or publication is created by local preparation alone.

## Decisions (2026-11-20)

- Project license: MIT. See `LICENSE` and `NOTICE`.
- The phone diagnostic harness is not part of this repository.
- A full-history scan for secrets, personal paths and device identifiers was
  run over every commit before this decision.
- Release gate 7 passed 2026-11-20: a fresh-HOME run of
  `MSC_PROVIDER_PROFILE=examples/providers/deepseek.json npm run demo:m1`
  finished with `completed` and `M1-DEMO-OK` against the loopback fake
  provider.
