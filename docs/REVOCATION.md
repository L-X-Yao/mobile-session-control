# Device revocation

Revocation invalidates the paired device token and every session token, and
discards retained session history. Use it when a phone is lost, replaced or its
browser storage may have leaked. Back up first if the history matters:
`npm run backup:state`.

A pre-revocation backup contains the old pair token. Restoring that backup makes
the revoked token valid again; after restoring one, revoke again before pairing
a replacement phone. Treat every pre-revocation backup as containing a leaked
token.

## From the web client

Close every open session first. The relay refuses revocation while a session is
active (`409 sessions_active`), because its host worker and manager cleanup
would outlive the revocation.

Then use **撤销本设备** in the session list. The client sends
`POST /v1/device/revoke`, clears local storage and returns to the pairing view.
When `pairingFile` is configured the service writes a fresh one-time code
there; configure it for any deployment that needs recovery. The old phone token
is invalid immediately; closed session history is cleared.

## Lost phone (operator)

Run this on the host with the service stopped. The script rewrites the state
file, replaces the device token and pairing code, and clears sessions:

```sh
systemctl --user stop msc-relay
npm run revoke:device -- \
  --state-file /home/<user>/msc-service/state.json \
  --state-key-file /home/<user>/msc-service/state.key
systemctl --user start msc-relay
```

Drop `--state-key-file` for a plaintext state file. For an encrypted state file
the key is required; without it the script refuses with `STATE_FILE_ENCRYPTED`.
The command prints the new pairing code; the restarted service also writes it to
the pairing file. Pair the replacement phone with that code.

Do not run the script while the service is running: the service holds the
in-memory state and will overwrite the file on its next snapshot.

## Limits

- Revocation removes retained closed sessions; export or back up first. A
  pre-revocation backup restores the old token; revoke again after restoring it.
- The internal manager token is preserved so the daemon can keep running; it is
  never given to a browser.
- Keep the `pairingFile` after pairing. It contains the URL and the live pairing
  code only while unpaired; it is the operator's recovery channel. It no longer
  needs to be deleted, and deleting it removes the convenient revocation path.
- A revoked device cannot recover access; re-pairing requires the host-side
  pairing file or service log.
