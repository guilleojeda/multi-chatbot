# Chat browser fixture

This local fixture mounts the production `AccountApp`, profile screen, chat screen, and
`createSession()` with deterministic in-memory Cognito, profile, and Runtime boundaries. It does not
contact AWS. Cognito and profile state remain in the fixture instance; the fake Runtime stores its
conversation records in a fixture-only `sessionStorage` key for the lifetime of the browser tab.
That key is separate from the product recovery journal and contains only the simulated conversation,
question, answer prefix, and status.
The mock Runtime accepts `start` once per new conversation ID and `message` for later turns with
that same ID. The sanitized request list and state JSON show the operation, ID, ordinal, and mock
turns. The profile route saves edits in fixture memory so navigation can exercise the real profile
form. Those saved values are not sent by the browser to Runtime; this fixture cannot prove which
profile snapshot the deployed server used to build model context.
The state JSON also shows `productJournal`, read only from the product's `chat-journal:v2` prefix
for this fixture scope. A pending entry includes the exact request text; an admitted entry shows
only its IDs and base ordinal. It never exposes refresh/access tokens or unrelated `sessionStorage`
keys.

Run the repository's existing Vite executable from the repository root:

```sh
npx vite --config tests/fixtures/chat/vite.config.ts --host 127.0.0.1
```

Open the local server URL printed by Vite. For navigation sequences, use a plain URL without a
query string and select the scenario in the fixture controls. The fixture opens `/#/chat` with a
restored test identity and complete profile. Choose a scenario before retrying an operation. The
Runtime stream emits an accepted event and a text fragment immediately; use the fixture controls to emit more
text, complete, fail, or close without a terminal event. `runtime-admission-pending` waits before
accepted so “Enviando consulta…” and the submit lock can be inspected; click “Admitir consulta” to
continue. The emitted answer includes accented text and blank lines for an exact copy check.
The fake producer records the question, answer prefix, and status before emitting each controlled
event. Closing the route or aborting its SSE consumer leaves that producer and record available in
the current fixture instance; a transport cancellation does not turn the record into a failure.
To exercise recovery, submit a query, click “Recargar pestaña y probar recuperación,” and inspect the
request history after the page returns. The product journal should issue `recover` with the same
conversation ID and query ID, receive JSON with the stored question/prefix/status, and avoid a new
`start`. Reloading an active record shows `in_progress`; reloading a completed or failed record
shows its terminal snapshot. After an active record is restored, the same “Emitir fragmento” and
terminal controls update that durable fixture record even though the prior SSE object no longer
exists; the next `recover` poll observes the new prefix or terminal state. This control bridge is a
local fixture aid, not survival of JavaScript or an AWS process. A follow-up after a completed
snapshot uses the recovered ordinal and a new query ID.
If the fake Runtime has no conversation or turn for the same IDs, it returns JSON
`conversation_unavailable` with `recordStatus: "not_admitted"` and HTTP 200, so the product keeps
the reference for an explicit retry. A record belonging to the other fixture identity remains a
403 without exposing its question or answer.
To inspect a temporarily unavailable state, start a query with `ready`, let it become active, and
reload the tab. Select `runtime-temporary`; the `recover` request returns HTTP 503, so the chat keeps
the same `streaming` state and shows the retryable status error while retaining its reference. Select
`ready` again; the next poll recovers the same prefix or terminal snapshot without a new `start`.
This scenario applies the one 503 control to Runtime requests, including `recover`; it does not
simulate a lost AWS process.
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
question should issue a `start` with a fresh ID. “Volver al inicio,” logout, a successful password
reset, or definitive access loss clears the product's recovery reference; a late producer callback
must not repopulate the visible chat. The fixture-only Runtime record remains owner-bound in the tab
storage so a new reference can recover it during the same local run. Closing the browser tab clears
that simulation. This behavior demonstrates the client/runtime contract locally; it does not prove
that an AWS task survives a process loss, and the deployed development verification must inspect the
real saved query context independently.

To inspect cupo presentation and draft retention without contacting the Runtime, select
`runtime-quota-daily`, `runtime-quota-monthly`, or `runtime-quota-both`, submit a question, and confirm
the request is rejected before admission. The daily fixture resets in 8 hours; the monthly fixture
resets in 21 days; when both are exhausted the message uses the later reset. The rejected question
stays in the composer. Select `ready` before an explicit retry to exercise fresh admission. After a
completed turn, select `runtime-conversation-busy` or `runtime-stale-base` before a follow-up to force
the corresponding public `conversation_busy` or `stale_base` rejection; neither creates an admitted
stream or advances the fixture's ordinal. These two selections exercise the web response handling;
runtime/store tests cover the actual occupied-thread and stale-base conditions.
`signout-pending` clears the session immediately while holding the simulated sign-out promise.
After clicking “Cerrar sesión”, use “Emitir fragmento (o tardío tras logout)” to release an old
stream callback and confirm that the login screen stays clear; then release “Liberar promesa de
logout”. The pending-profile scenario waits for “Liberar perfil”.

To test password reset while a chat stream is open, send a query, navigate to `/#/recover`, request
a code, choose `password-reset-pending`, and confirm the new password. The confirmation remains
pending until one of the two password-reset controls is used. While it is pending, open `/#/chat` or
`/#/profile` and let “Comprobando tu acceso…” appear. “Confirmar cambio de contraseña” should clear
the old chat and tokens, abort its Runtime consumer, and return to login with a usable sign-in form
and success notice. After signing in as the same fixture identity, return to chat and use “Emitir
fragmento” to confirm the old question and answer stay absent. “Rechazar cambio de contraseña” should
retain the session, thread, and open stream, then reauthorize the current protected route. In chat,
use “Emitir fragmento” to confirm the answer continues; from profile, return to chat first. The
existing `password-reset-failure` scenario still returns an immediate code mismatch on the recovery
screen for checking its error message.

The reset and refresh gates are independent: changing the scenario does not discard an already
pending HTTP 401, refresh, password-reset confirmation, sign-in, or clipboard Promise. To exercise
a rejected reset while refresh is pending, start a chat send with `runtime-401-pending`, release
“Responder 401 de Runtime”, and wait for “refresh pendiente: 1”. Open `/#/recover`, request a code
for the fake identity, select `password-reset-pending`, and confirm with any fixture-only code and
password. Select `ready` after the confirmation is held. Reject the reset, return to chat, and
release “Liberar refresh Cognito”; the existing request should retry once, preserve its conversation
ID and partial answer, and leave the same fixture session active. For the success control, repeat
the setup and confirm the reset before releasing refresh; the session and chat must stay cleared,
and the late refresh must not restore them.

The fixture exposes two in-memory valid invitations for existing accounts:
`/#/invite?token=fixture-existing-invitation` for identity A and
`/#/invite?token=fixture-existing-invitation-b` for identity B. The invitation's email field is
read-only, as in the product, and the simulated accept endpoint checks that the signed-in `sub`
matches the selected invitation. Start a chat send with `runtime-401-pending`, release its 401, and
wait for a pending refresh. Open either invitation and select `sign-in-pending`; its email is
pre-filled for A (`docente@example.test`) or B (`docente-b@example.test`). Submit with a fake
password. For the during-sign-in case, release the old refresh before “Liberar inicio de sesión”; for
the after-membership case, release sign-in, wait for access to become active, then release the old
refresh. Neither order should log out the new session or retry the old Runtime request. The two
synthetic users have distinct `sub` claims and matching saved profile records; the invitations are
fixture-only and do not alter a real membership.

To test delayed clipboard completion, complete an answer, select `clipboard-pending`, and click its
“Copiar respuesta” action. The fixture retains the exact string passed to `navigator.clipboard` and
shows a per-operation completion/rejection button and sanitized state JSON. For the first variant,
start a follow-up while the earlier answer copy is pending, then reject that earlier copy; its error
must not appear by the new answer. For the second, restart the chat and submit a new question before
rejecting the old copy; the new conversation must stay free of that error. For overlapping copies,
complete a first answer and a follow-up, start copies of the previous and current answers, reject
the current copy, then complete the previous copy; the current answer's error must remain attached
to that answer. Compare each queued text with its visible completed answer to check exact copying;
the fixture never writes to the operating-system clipboard.

Append `?scenario=<name>` before the hash to select an initial scenario, for example
`/?scenario=profile-pending#/chat`. Supported names are `ready`, `incomplete`, `profile-error`,
`profile-pending`, `profile-save-error`, `membership-denied`, `membership-unauthorized`,
`membership-temporary`, `membership-network`, `config-temporary`, `runtime-admission-pending`,
`runtime-temporary`, `runtime-quota-daily`, `runtime-quota-monthly`, `runtime-quota-both`,
`runtime-conversation-busy`, `runtime-stale-base`, `runtime-401`, `runtime-401-pending`,
`runtime-expired`, `runtime-forbidden`,
`password-reset-pending`, `password-reset-failure`, `signout-pending`, `sign-in-pending`,
`clipboard-fail`, and `clipboard-pending`. The selector also changes the scenario for the next
matching operation without reloading; pending operations keep their own controls when the selection
changes.
