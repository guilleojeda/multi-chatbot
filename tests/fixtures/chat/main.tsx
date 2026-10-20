import { createRoot } from "react-dom/client";
import { useEffect, useReducer } from "react";
import { siteConfig } from "../../../config/site";
import { AccountApp, type AccountRoute } from "../../../web/AccountApp";
import { ChatBrowserFixture, fixtureScenarios, type FixtureScenario } from "./harness";
import "../../../web/style.css";
import "../profile/style.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The chat fixture root is missing");

if (!window.location.hash) window.history.replaceState(null, "", "#/chat");

document.title = siteConfig.projectName + " · Fixture local del chat";

const fixture = new ChatBrowserFixture();
window.fetch = (input, init) => fixture.fetch(input, init);

function routeFromHash(hash: string): AccountRoute | null {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!route || route === "/") return null;
  if (route === "/chat") return { kind: "chat" };
  if (route === "/profile") return { kind: "profile" };
  if (route === "/login") return { kind: "login" };
  return null;
}

function FixtureControls() {
  const [, forceRender] = useReducer((revision: number) => revision + 1, 0);
  const state = fixture.snapshot(window.location.hash);
  const counts = state.requests.reduce<Record<string, number>>((result, request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});

  useEffect(() => fixture.subscribe(forceRender), []);
  useEffect(() => {
    const update = () => forceRender();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  return (
    <aside className="profile-fixture-controls" aria-label="Controles de la fixture del chat">
      <header className="profile-fixture-heading">
        <p className="profile-fixture-eyebrow">Control local</p>
        <h2>Fixture de navegador del chat</h2>
        <p>
          Esta página monta AccountApp y ChatScreen reales. Cuenta, perfil y Runtime se simulan en
          memoria; no se usan Cognito, AWS ni almacenamiento persistente.
        </p>
      </header>

      <section className="profile-fixture-control-group" aria-labelledby="chat-fixture-scenario">
        <h3 id="chat-fixture-scenario">Escenario para la próxima operación</h3>
        <label htmlFor="chat-fixture-scenario-select">Escenario</label>
        <select
          id="chat-fixture-scenario-select"
          value={state.scenario}
          onChange={(event) => fixture.selectScenario(event.currentTarget.value as FixtureScenario)}
        >
          {fixtureScenarios.map(({ id, label }) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
        <nav className="profile-fixture-links" aria-label="Rutas locales">
          <a href="#/chat">Abrir chat</a>
          <a href="#/profile">Abrir perfil</a>
          <a href="#/login">Abrir cuenta</a>
        </nav>
        <button
          className="profile-fixture-reset"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reiniciar fixture
        </button>
      </section>

      <section className="profile-fixture-control-group" aria-labelledby="chat-fixture-stream">
        <h3 id="chat-fixture-stream">Controlar la respuesta abierta</h3>
        <button
          type="button"
          disabled={!state.pendingAdmissions}
          onClick={() => fixture.admitStream()}
        >
          Admitir consulta
        </button>
        <button
          type="button"
          disabled={!state.admittedStreams}
          onClick={() => fixture.emitFragment()}
        >
          Emitir fragmento (o tardío tras logout)
        </button>
        <div className="profile-fixture-gates">
          <button
            type="button"
            disabled={!state.admittedStreams}
            onClick={() => fixture.finishStream("complete")}
          >
            Completar
          </button>
          <button
            type="button"
            disabled={!state.admittedStreams}
            onClick={() => fixture.finishStream("failed")}
          >
            Fallar
          </button>
          <button
            type="button"
            disabled={!state.admittedStreams}
            onClick={() => fixture.finishStream("unconfirmed")}
          >
            Cerrar sin cierre
          </button>
          <button
            type="button"
            disabled={!state.pendingProfiles}
            onClick={() => fixture.releaseProfile()}
          >
            Liberar perfil
          </button>
          <button
            type="button"
            disabled={!state.pendingSignOuts}
            onClick={() => fixture.releaseSignOut()}
          >
            Liberar promesa de logout
          </button>
        </div>
        <p className="profile-fixture-readout">
          Perfiles pendientes: {state.pendingProfiles} · logout pendiente: {state.pendingSignOuts} ·
          admisiones pendientes: {state.pendingAdmissions} · respuestas admitidas:{" "}
          {state.admittedStreams}
        </p>
      </section>

      <section className="profile-fixture-control-group" aria-labelledby="chat-fixture-state">
        <h3 id="chat-fixture-state">Resumen</h3>
        <p className="profile-fixture-readout">
          Sesión: {state.session.active ? "activa" : "cerrada"} · peticiones: {state.requestCount}
        </p>
        <p className="profile-fixture-readout">
          {Object.entries(counts)
            .map(([key, count]) => `${key} × ${count}`)
            .join(" · ")}
        </p>
        <details>
          <summary>Historial de peticiones sanitizado</summary>
          <div className="profile-fixture-request-list">
            {state.requests.map((request) => (
              <article className="profile-fixture-request" key={request.number}>
                <strong>
                  {request.number}. {request.method} {request.url}
                </strong>
                <span>
                  bearer: {request.authenticated ? "presente" : "ausente"}
                  {request.sessionId ? ` · session ID: ${request.sessionId}` : ""}
                  {request.accept ? ` · accept: ${request.accept}` : ""}
                </span>
                <span>
                  HTTP/stream: {request.status} · {request.outcome}
                </span>
                {request.body !== undefined ? <code>{JSON.stringify(request.body)}</code> : null}
              </article>
            ))}
          </div>
        </details>
        <details>
          <summary>Estado JSON sin credenciales</summary>
          <pre data-fixture="chat-state-json">{JSON.stringify(state, null, 2)}</pre>
        </details>
      </section>

      <footer className="profile-fixture-footer">
        Fixture local y volátil. El botón de reinicio limpia estado, sesión y peticiones.
      </footer>
    </aside>
  );
}

function App() {
  const [hash, setHash] = useReducer(
    (_current: string, next: string) => next,
    window.location.hash,
  );

  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  const route = routeFromHash(hash) || { kind: "chat" as const };
  return (
    <div className="profile-fixture-layout">
      <div className="profile-fixture-product">
        <AccountApp
          route={route}
          projectName={siteConfig.projectName}
          profileConfig={siteConfig.profile}
          getSession={() => fixture.session}
        />
      </div>
      <FixtureControls />
    </div>
  );
}

createRoot(rootElement).render(<App />);
