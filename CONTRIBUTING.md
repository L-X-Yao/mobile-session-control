# Contributing

This project is a private, self-hosted control layer for local Claude
Code-compatible sessions. The default posture is loopback-only and the test
suite uses fake providers only.

## Requirements

- Node.js 22 or newer.
- No package dependencies; `npm test` runs from a fresh clone without install.

## Before you send a change

1. Run `npm test` (syntax, secret/path scan, CLI tests).
2. Install the local hooks once with `npm run hooks:install`; the pre-commit
   hook runs `npm run precommit`.
3. Keep tests offline: loopback fake providers, fresh temporary HOME/config and
   no real credentials, phone, ADB or public listener.
4. Never commit `.local/`, keys, tokens, pairing files, run directories, raw
   logs or evidence; the scan and the hook reject known patterns.
5. For security-sensitive changes, add a focused regression test and describe
   the threat you are closing.

## Scope boundaries

- The relay must stay loopback-only by default; remote access is a separate
  private-network decision.
- The Claude Agent SDK and the Claude Code executable are external dependencies;
  do not bundle them.
- Real-provider, real-phone and 24-hour claims require direct evidence. Use
  `NO_DATA` when evidence is unavailable instead of converting it to a pass.
- Read `docs/DEVELOPMENT-WORKFLOW.md` for the review gates and
  `docs/OPEN-SOURCE-BOUNDARY.md` for the publication boundary.

## License

By contributing you agree that your contributions are licensed under the MIT
License in `LICENSE`.
