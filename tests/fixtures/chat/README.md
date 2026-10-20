# Chat browser fixture

This local fixture mounts the production `AccountApp`, profile screen, chat screen, and
`createSession()` with deterministic in-memory Cognito, profile, and Runtime boundaries. It does not
contact AWS or persist data.
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

To verify that a terminal Runtime event cannot replace a profile-read error, submit a query and leave
its stream open. Open “Mi perfil” while the stream is active, select `profile-error`, and return to
chat so the chat's own profile read receives 503. Use “Fallar generación” and confirm both the
profile error with “Reintentar” and the generation failure remain visible, with no composer. Retry
the profile after selecting `ready`; the composer should return while the query failure remains
visible. Repeat the open-stream sequence and use “Completar” instead; the profile error and retry
must remain, and the completed answer stays visible. To verify the authoritative admission result,
use “Rechazar por perfil incompleto”; the profile becomes incomplete and the composer stays hidden.

To reproduce the profile-save/refresh race with the real session implementation, select
`runtime-401-pending` and send a query. While its Runtime POST is held, open “Mi perfil” and wait for
the form. Click “Responder 401 de Runtime”; wait for “refresh pendiente: 1.” Edit a field and save.
The first PUT should receive 401 and wait for that same real `createSession().restore()` call. There
must be no sign-out. Click “Liberar refresh Cognito”; the PUT should retry once and save, while the
Runtime request retries once with the renewed token and resumes its stream. Complete it and return
to chat to confirm the same turn remains visible. The request history records only redacted bearer
presence and status, never token values.

For reset during a pending profile read, complete a turn, select `profile-pending`, open “Mi perfil,”
and return to chat before releasing either profile request. Click “Volver al inicio,” then release
every pending profile request. The first result belongs to the canceled read; the new chat's profile
read must complete, leaving the composer available. Before the fix, the new chat stayed on
“Cargando tu perfil” after both requests had settled.

To check temporary route failures without losing the same chat, complete a turn, leave a Runtime
stream open, select `membership-temporary`, and open “Mi perfil.” The account check returns 503 and
the route should show a retryable error while the chat content and stream remain in memory. Select
`ready`, retry, wait for the profile form, then return to chat; the prior turn and open stream should
still be present. Repeat with `membership-network` to exercise a rejected fetch and with
`config-temporary` to fail the public configuration request before membership checking. For
definitive access loss, repeat with `membership-denied` (403) or `membership-unauthorized` (401);
the route should clear chat content and abort the stream, and a retry must not restore it.

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

To verify password reset while a chat stream is open, send a query and navigate to `/#/recover`.
Request a code, select `signout-pending`, and confirm it with a new password. On success, the app
should clear the old thread and abort its Runtime consumer before returning to login. This scenario
leaves the old stream available for a deliberate late callback; after signing in as the same fixture
identity, return to chat and use “Emitir fragmento” to confirm the old question and answer stay
absent. For the rejected path, select `password-reset-failure` before confirming the reset. Cognito
returns a code mismatch while retaining the session; return to chat and use “Emitir fragmento” to
confirm the same turn continues.

Append `?scenario=<name>` before the hash to select an initial scenario, for example
`/?scenario=profile-pending#/chat`. Supported names are `ready`, `incomplete`, `profile-error`,
`profile-pending`, `profile-save-error`, `membership-denied`, `membership-unauthorized`,
`membership-temporary`, `membership-network`, `config-temporary`, `runtime-admission-pending`,
`runtime-401`, `runtime-401-pending`, `runtime-expired`, `runtime-forbidden`,
`password-reset-failure`, `signout-pending`, and `clipboard-fail`. The selector also changes the
scenario for the next matching operation without reloading.
