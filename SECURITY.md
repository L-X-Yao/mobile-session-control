# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Use the repository's
**Security** tab and choose **Report a vulnerability** so the report stays
private. If that form is unavailable, contact the maintainer directly through
GitHub (`@L-X-Yao`).

Include the affected version or commit, the deployment mode (fake or real), the
smallest reproduction you have, and whether a real provider key or phone token
may have been exposed. Do not include key values, tokens or private machine
paths in the report; describe where they are instead.

## Scope

In scope: the relay's authentication and loopback-only default, session token
handling, approval and Stop semantics, the launcher guard, the allowlist proxy,
path and permission checks on private profiles, and the web client's handling of
tokens and approvals.

Out of scope by default: deployments that expose the relay without a private
network, modified provider wrappers, and issues that require running with real
credentials the reporter is not authorized to use.

## Supported versions

This is a pre-1.0 project; only the latest `main` and the most recent release
receive fixes.
