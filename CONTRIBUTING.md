# Contributing

This project is a private, self-hosted control layer for local Claude
Code-compatible sessions. The default posture is loopback-only and the test
suite uses fake providers only. Participation is covered by
`CODE_OF_CONDUCT.md`.

## Requirements

- Node.js 22 or newer.
- No package dependencies; `npm test` runs from a fresh clone without install.

## Before you send a change

1. Run `npm test` (syntax, tracked-path policy, secret/path scan, CLI tests)
   and `npm run scenario` (offline end-to-end fake slice).
2. Install the local hooks once with `npm run hooks:install`; the pre-commit
   hook runs `npm run precommit`, which refuses unstaged tracked changes and
   untracked files before running the suite.
3. Keep tests offline: loopback fake providers, fresh temporary HOME/config and
   no real credentials, phone, ADB or public listener. `npm run e2e:web` needs
   the optional external Playwright package; it skips when that is absent.
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
