# Chat browser fixture

This local fixture mounts the production `AccountApp`, profile screen, and chat screen with a
deterministic in-memory Session and fetch boundary. It does not contact AWS or persist data.

Run the repository's existing Vite executable from the repository root:

```sh
npx vite --config tests/fixtures/chat/vite.config.ts --host 127.0.0.1
```

Open the local server URL printed by Vite. The fixture opens `/#/chat` with a restored test
identity and complete profile. Choose a scenario before retrying an operation. The Runtime stream
emits an accepted event and a text fragment immediately; use the fixture controls to emit more
text, complete, fail, or close without a terminal event. `runtime-admission-pending` waits before
accepted so “Enviando consulta…” and the submit lock can be inspected; click “Admitir consulta” to
continue. The emitted answer includes accented text and blank lines for an exact copy check.
`signout-pending` clears the session immediately while holding the simulated sign-out promise.
After clicking “Cerrar sesión”, use “Emitir fragmento (o tardío tras logout)” to release an old
stream callback and confirm that the login screen stays clear; then release “Liberar promesa de
logout”. The pending-profile scenario waits for “Liberar perfil”.

Append `?scenario=<name>` before the hash to select an initial scenario, for example
`/?scenario=profile-pending#/chat`. Supported names are `ready`, `incomplete`, `profile-error`,
`profile-pending`, `membership-denied`, `runtime-admission-pending`, `runtime-401`,
`runtime-expired`, `runtime-forbidden`, `signout-pending`, and `clipboard-fail`. The selector also
changes the scenario for the next matching operation without reloading.
