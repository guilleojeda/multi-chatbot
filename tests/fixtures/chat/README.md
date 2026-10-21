# Chat browser fixture

This local fixture mounts the production `AccountApp`, profile screen, chat screen, and
`createSession()` with deterministic in-memory Cognito, profile, and Runtime boundaries. It does not
contact AWS. Cognito and profile state remain in the fixture instance. `createSession()` uses a
fixture-owned in-memory `Storage` map for its synthetic refresh token; that map is recreated on page
reload. The product journal and the fake Runtime's conversation records use the browser's real
`window.sessionStorage` for this tab and survive reloads. The Runtime records use a fixture-only key
separate from the product recovery journal and contain only the simulated conversation, question,
answer prefix, and status.
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
query string and select the scenario in the fixture controls. For a scenario that must run during
initialization or recovery, load it directly as `/?scenario=<name>#/chat` on the same origin and tab.
The fixture opens `/#/chat` with a restored test identity and complete profile. Choose a scenario
before retrying an operation. The Runtime stream emits an accepted event and a text fragment
immediately; use the fixture controls to emit more text, complete, fail, or close without a terminal
event. `runtime-admission-pending` waits before accepted so “Enviando consulta…” and the submit lock
can be inspected; click “Admitir consulta” to continue. The emitted answer includes accented text and
blank lines for an exact copy check.
The fake producer records the question, answer prefix, and status before emitting each controlled
event. Aborting its SSE consumer leaves the producer available in the current fixture instance; a
transport cancellation does not turn the record into a failure. “Cerrar SSE antes de admitir” can
close a held consumer while leaving the pending producer available for “Admitir consulta.”
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
simulate a lost AWS process. `runtime-recover-network` instead rejects only a `recover` request with
a network `TypeError`, leaving start/message requests unaffected.

### Recovery and retry checks

- **R2, uncertain result and exact retry:** select `runtime-unconfirmed` and submit a question. The
  first Runtime POST returns the contract's `failed` result with code `temporarily_unavailable`,
  `recordStatus: "unconfirmed"`, and its `queryId`; the fixture creates no conversation turn. Wait
  for the automatic `recover` lookup to report `conversation_unavailable/not_admitted`. The composer
  should retain the question and show “Reintentar el mismo envío.” In the product-journal JSON, the
  entry remains unadmitted and includes the exact body. Select `ready`, then click the retry button.
  Compare the two POST bodies: operation, conversation ID, query ID, base ordinal, and text must
  match. There is no second admission request (`start` or `message`) or admitted turn before the
  explicit click, apart from the automatic `recover` lookup; the retry admits one turn under the
  original IDs.
- **R2, lost acceptance event:** select `runtime-admission-pending` and submit a question. While
  “Admisiones pendientes” is nonzero, click “Cerrar SSE antes de admitir,” then “Admitir consulta.”
  The fake producer persists the turn but cannot deliver `accepted` to the disconnected consumer.
  The product journal remains pending with its question. Reload the same origin at
  `/?scenario=ready#/chat`. Recovery should show the stored question and prefix for the same IDs,
  with no new `start`. The request history resets with the fixture instance, so after reload compare
  its `recover` body with the IDs in `productJournal` and confirm there is no `start` in the new
  history.
- **R3, Cognito refresh network failure:** begin with an admitted query, then load the same origin
  and tab at `/?scenario=cognito-refresh-network#/chat`. The real `createSession().restore()` makes
  `REFRESH_TOKEN_AUTH`; the fixture rejects that Cognito call with `TypeError("Failed to fetch")`.
  Initialization should show its retryable access error before sending `recover`, while the
  admitted product-journal reference remains. Select `ready` in the fixture controls and click the
  account screen's “Reintentar.” The new initialization should restore the synthetic identity and
  recover the same query ID and snapshot, with no new `start`.
- **R5, admitted journal and recover network failure:** begin with an accepted query and reload the
  same origin and tab at `/?scenario=runtime-recover-network#/chat`. The first `recover` alone fails
  with a network `TypeError`; the chat must retain its admitted streaming snapshot and show a
  status message. It must not offer “Reintentar el mismo envío.” Select `ready` before the scheduled
  poll (one second after the first failure). The next `recover` should return the same in-progress
  snapshot and prefix. The request history should contain no new `start` or `message`.
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
For C's input-capacity flows, these local scenarios simulate public Runtime failures before any
fixture conversation turn or usage record is created; they do not call AWS or run the native token
counter:

- To check a native-count failure, select `runtime-token-count-unavailable`, submit a question, and
  confirm the message says that the count could not be checked, no quota notice appears, and the
  composer keeps the exact text. The request list and product-journal JSON show the same query ID
  and body. Select `ready`, then click “Reintentar el mismo envío”; compare the second request's
  query ID, conversation ID, operation, ordinal, and text with the first. No second request should
  appear before that explicit click.
- To check history capacity, complete a turn under `ready`, select
  `runtime-capacity-exceeded`, and send a follow-up. The simulated failure applies only to
  `message`, so the completed turn remains in the fixture's stored conversation. Confirm the
  rejected follow-up remains in the composer state, then click “Volver al inicio.” The new chat
  should retain that draft. Submit it and inspect the request list: the operation should be `start`
  with a different conversation ID, while the old simulated conversation and turn remain in the
  fixture state. No remote delete operation is available in this fixture.
- To check the DynamoDB preflight distinction, select `runtime-storage-capacity-exceeded` before
  submitting. The mock returns `storage_capacity_exceeded` without a quota view or admitted turn;
  the original text remains editable so it can be corrected. This local response exercises the web
  state only; the acceptance tests exercise the actual storage preflight.

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

**R4, reset and same-person re-entry:** with an admitted query visible, load the same origin
and tab directly at `/?scenario=ready#/recover` so AccountApp mounts without first opening chat.
Request a code and confirm a fixture-only password reset. Sign in again as identity A
(`docente@example.test`) and open chat. The product journal must be empty and no request should
recover or display the old query. The fixture's simulated Runtime record may still exist in its
separate storage key; without the product reference it is not restored.

**R4, logout and same-person re-entry:** with another admitted query present, load the same origin
and tab directly at `/?scenario=ready#/login`. After session restoration, click “Cerrar sesión” on
that same login route, sign in again as the same identity, and open chat. The old query should
remain absent and the request history should contain no `recover` for it. This tests cleanup
without a local chat owner and without relying on a subsequent hash change to clear storage.

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

**R6, failed copy of a partial while a follow-up starts:** submit question A with `ready`, let the
first prefix appear, and click “Fallar generación.” Once A is visibly failed but continuable, select
`clipboard-pending` and click “Copiar texto parcial.” Enter and submit question B. In the fixture
controls, reject A's pending copy operation. The alert should appear under A after it moves into
previous turns; B must have no copy alert. A remains labeled “Respuesta incompleta” and its
historical block has no copy button.

Append `?scenario=<name>` before the hash to select an initial scenario, for example
`/?scenario=profile-pending#/chat`. Supported names are `ready`, `incomplete`, `profile-error`,
`profile-pending`, `profile-save-error`, `membership-denied`, `membership-unauthorized`,
`membership-temporary`, `membership-network`, `config-temporary`, `runtime-admission-pending`,
`runtime-unconfirmed`, `runtime-temporary`, `runtime-recover-network`, `runtime-quota-daily`,
`runtime-quota-monthly`, `runtime-quota-both`,
`runtime-capacity-exceeded`, `runtime-token-count-unavailable`,
`runtime-storage-capacity-exceeded`, `runtime-conversation-busy`, `runtime-stale-base`,
`runtime-401`, `runtime-401-pending`, `cognito-refresh-network`,
`runtime-expired`, `runtime-forbidden`,
`password-reset-pending`, `password-reset-failure`, `signout-pending`, `sign-in-pending`,
`clipboard-fail`, and `clipboard-pending`. The selector also changes the scenario for the next
matching operation without reloading; pending operations keep their own controls when the selection
changes.
