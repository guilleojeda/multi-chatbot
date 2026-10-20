# Chat browser fixture

This local fixture mounts the production `AccountApp`, profile screen, and chat screen with a
deterministic in-memory Session and fetch boundary. It does not contact AWS or persist data.
The mock Runtime accepts `start` once per new conversation ID and `message` for later turns with
that same ID. The sanitized request list and state JSON show the operation, ID, ordinal, and mock
turns. The profile route saves edits in fixture memory so navigation can exercise the real profile
form. Those saved values are not sent by the browser to Runtime; this fixture cannot prove which
profile snapshot the deployed server used to build model context.

Run the repository's existing Vite executable from the repository root:

```sh
npx vite --config tests/fixtures/chat/vite.config.ts --host 127.0.0.1
```

Open the local server URL printed by Vite. For navigation sequences, use a plain URL without a
query string and select the scenario in the fixture controls; product links drop query parameters,
which would reload this in-memory fixture. The fixture opens `/#/chat` with a restored test
identity and complete profile. Choose a scenario before retrying an operation. The Runtime stream
emits an accepted event and a text fragment immediately; use the fixture controls to emit more
text, complete, fail, or close without a terminal event. `runtime-admission-pending` waits before
accepted so “Enviando consulta…” and the submit lock can be inspected; click “Admitir consulta” to
continue. The emitted answer includes accented text and blank lines for an exact copy check.
After a completed exchange, send a follow-up and confirm the request list shows `message` with the
same conversation ID and the next ordinal. While a stream is open, open “Mi perfil,” wait for the
profile form, then return to chat and confirm the same partial answer and pending request remain;
the fixture keeps the stream active while the product route changes. Save a profile edit and return
to chat to exercise a fresh profile read. Alternatively, make a draft and discard it; the fixture's
stored profile should retain the saved value. The mock cannot validate the server's context snapshot.
To check a failed save, open the profile, edit a value, select `profile-save-error`, then save. The
mock returns the profile API's 503 error without applying the update; its stored-profile value in the
state JSON should still show the last saved profile.

To exercise access loss while a stream is open, start a query and select `membership-denied` in the
fixture controls before opening “Mi perfil.” The profile GET returns 403, so `AccountApp` should
clear the chat and invalidate the open stream. “Emitir fragmento” should not restore stale text.
The same scenario rejects profile PUTs if a save is attempted directly.

Use “Fallar” to close a query with a confirmed failure, then submit a new question. The next request
should be `message` on the same ID while the previous exchange stays visible. Use “Cerrar sin cierre”
for an uncertain result: record the Runtime request count, let the stream reach EOF, and verify the
count stays unchanged when the error appears and after choosing restart. Only submitting a new
question should issue a `start` with a fresh ID. Reload or sign out after a completed exchange to
confirm the fixture starts without restored conversation content. The fixture reset is volatile;
the deployed development verification must independently confirm no history restore and inspect
the real saved query context.
`signout-pending` clears the session immediately while holding the simulated sign-out promise.
After clicking “Cerrar sesión”, use “Emitir fragmento (o tardío tras logout)” to release an old
stream callback and confirm that the login screen stays clear; then release “Liberar promesa de
logout”. The pending-profile scenario waits for “Liberar perfil”.

Append `?scenario=<name>` before the hash to select an initial scenario, for example
`/?scenario=profile-pending#/chat`. Supported names are `ready`, `incomplete`, `profile-error`,
`profile-pending`, `profile-save-error`, `membership-denied`, `runtime-admission-pending`,
`runtime-401`, `runtime-expired`, `runtime-forbidden`, `signout-pending`, and `clipboard-fail`. The
selector also changes the scenario for the next matching operation without reloading.
