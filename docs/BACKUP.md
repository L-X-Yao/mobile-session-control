# Backup and restore

The durable service keeps everything in one private state directory
(`/home/<user>/msc-service` in the reference deployment). Back up the directory
except the transient `runs/` tree.

## What to back up

| File | Purpose |
|---|---|
| `state.json` | AES-256-GCM snapshot: tokens, sessions, pending approvals |
| `state.key` | 32-byte key for the snapshot; without it `state.json` is unreadable |
| `pairing.json` | Pairing state and URL; a consumed code cannot be reused |
| `service.json` | Service configuration |
| `phase9.json` | Private provider profile paths (real mode) |
| `events.jsonl` | Append-only host event log; optional for recovery |
| `native-registry.json` | Optional native mode: stable provider IDs to session IDs; 0600 |

The archive contains tokens and encrypted session content. Keep it owner-only
and outside the repository.

## Online backup

```sh
npm run backup:state -- \
  --state-dir /home/<user>/msc-service \
  --out /private/backup/msc-service-2026-11-20.tgz
```

The script writes mode 0600, refuses to overwrite without `--force`, requires
absolute paths, and excludes `runs/`. It is safe while the service runs:
`state.json` is replaced with an atomic rename, and `events.jsonl` only
appends. A line being appended during the copy may be truncated, which does not
affect state recovery.

Run a restore drill after each backup or deployment change:

```sh
npm run restore:drill -- --backup /private/backup/msc-service-2026-11-20.tgz
```

It extracts into a temporary directory, rejects unsafe entries and symlinks,
checks owner-only modes, parses the JSON files and decrypts an encrypted
snapshot with the archived `state.key` (or `--state-key-file`). It never touches
the live service.

## Restore

1. Stop the service: `systemctl --user stop msc-relay`.
2. Move the current directory aside instead of deleting it.
3. Create the target directory with mode 0700 and extract the archive into it:

   ```sh
   mkdir -p /home/<user>/msc-service && chmod 700 /home/<user>/msc-service
   tar -xzf /private/backup/msc-service-2026-11-20.tgz -C /home/<user>/msc-service
   ```

4. Confirm `state.key` and `state.json` are mode 0600 and owned by the service
   user.
5. Restore the same absolute path the unit and `service.json` expect.
6. Start the service and check `http://127.0.0.1:8787/v1/health` and that the
   phone is still paired.

If `state.key` and `state.json` are lost together, delete `state.json`, restart
and re-pair; sessions and tokens are discarded.

A backup taken before device revocation contains the old pair token. Restoring
it revives that token; revoke the device again immediately after such a restore.
See `docs/REVOCATION.md`.

## Retention

`events.jsonl` rotates by size: `eventLogMaxBytes` (default 10 MiB) and
`eventLogKeep` (default 2 archives, `0` truncates). Rotation never changes
permissions. Keep backups outside the state directory and test one restore into
a scratch directory after changing the deployment.
