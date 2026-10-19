import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { siteConfig } from "../../../config/site";
import { AccountApp, type AccountRoute } from "../../../web/AccountApp";
import { PublicSite } from "../../../web/PublicSite";
import type { FixtureIdentity, FixtureScenario } from "./harness";
import { ProfileBrowserFixture, fixtureScenarios } from "./harness";
import "../../../web/style.css";
import "./style.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The profile fixture root is missing");

document.title = siteConfig.projectName + " · Fixture local del perfil";

const fixture = new ProfileBrowserFixture(siteConfig.botId);
window.fetch = (input, init) => fixture.fetch(input, init);

function routeFromHash(hash: string): AccountRoute | null {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!route || route === "/") return null;

  const questionIndex = route.indexOf("?");
  const pathname = questionIndex < 0 ? route : route.slice(0, questionIndex);
  const query = questionIndex < 0 ? "" : route.slice(questionIndex + 1);
  if (pathname === "/login") return { kind: "login" };
  if (pathname === "/profile") return { kind: "profile" };
  if (pathname === "/recover") return { kind: "recover" };
  if (pathname === "/invite") {
    return { kind: "invite", token: new URLSearchParams(query).get("token") };
  }
  return null;
}

function FixtureControls() {
  const [message, setMessage] = useState("");
  const [revision, forceRender] = useReducer((value: number) => value + 1, 0);
  const state = fixture.snapshot(window.location.hash);
  const requestCounts = state.requests.reduce<Record<string, number>>((counts, request) => {
    const key = request.method + " " + request.path;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  useEffect(() => fixture.subscribe(forceRender), []);

  function openAsSelectedIdentity() {
    if (!fixture.prepareRestorableIdentity()) {
      setMessage("Fixture: cerrá la sesión actual antes de cambiar de identidad.");
      return;
    }
    setMessage("Fixture: la identidad seleccionada se restaurará al abrir Mi perfil.");
    window.location.hash = "/profile";
  }

  function resetFixture() {
    window.location.reload();
  }

  return (
    <aside
      className="profile-fixture-controls"
      aria-label="Controles Fixture del perfil"
      data-fixture-revision={revision}
    >
      <header className="profile-fixture-heading">
        <p className="profile-fixture-eyebrow">Control local</p>
        <h2>Fixture de navegador del perfil</h2>
        <p>
          La interfaz usa AccountApp y ProfileApp reales. Las llamadas de configuración, cuenta y
          perfil quedan simuladas en memoria; no se usan Cognito ni almacenamiento del navegador.
        </p>
      </header>

      <section className="profile-fixture-control-group" aria-labelledby="fixture-session-title">
        <h3 id="fixture-session-title">Fixture: identidad y navegación</h3>
        <label htmlFor="fixture-identity">Fixture: identidad seleccionada</label>
        <select
          id="fixture-identity"
          value={state.selectedIdentity}
          onChange={(event) => {
            fixture.selectIdentity(event.currentTarget.value as FixtureIdentity);
            setMessage("");
          }}
        >
          <option value="A">Docente de prueba A</option>
          <option value="B">Docente de prueba B</option>
        </select>
        <button type="button" onClick={openAsSelectedIdentity}>
          Fixture: abrir Mi perfil con sesión restaurada
        </button>
        <nav className="profile-fixture-links" aria-label="Rutas de prueba Fixture">
          <a href="#/profile">Fixture: ruta directa #/profile</a>
          <a href="#/login">Fixture: abrir #/login</a>
          <a href="#/recover">Fixture: recuperar acceso</a>
          <a href="#/invite?token=fixture-new">Fixture: invitación nueva</a>
          <a href="#/invite?token=fixture-existing">Fixture: invitación existente</a>
          <a href="#/">Fixture: abrir página pública</a>
        </nav>
        <p className="profile-fixture-readout" aria-live="polite">
          Identidad activa: {state.session.activeIdentity || "sin sesión"} · sesión restaurable:{" "}
          {state.session.restorableIdentity || "no"}
        </p>
        {message ? (
          <p className="profile-fixture-message" role="status">
            {message}
          </p>
        ) : null}
      </section>

      <section className="profile-fixture-control-group" aria-labelledby="fixture-scenario-title">
        <h3 id="fixture-scenario-title">Fixture: estado inicial y próxima respuesta</h3>
        <label htmlFor="fixture-scenario">Fixture: escenario</label>
        <select
          id="fixture-scenario"
          value={state.selectedScenario}
          onChange={(event) => fixture.selectScenario(event.currentTarget.value as FixtureScenario)}
        >
          {fixtureScenarios.map(({ id, label }) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
        <p className="profile-fixture-readout" aria-live="polite">
          Escenario{" "}
          {state.scenarioArmed ? "armado para la próxima operación" : "sin respuesta pendiente"}.
          Cambiar a “Perfil vacío” o “Perfil previo” prepara el registro de la identidad
          seleccionada.
        </p>
        <button className="profile-fixture-reset" type="button" onClick={resetFixture}>
          Fixture: reiniciar la página y el estado simulado
        </button>
      </section>

      <section className="profile-fixture-control-group" aria-labelledby="fixture-gates-title">
        <h3 id="fixture-gates-title">Fixture: liberar operaciones retenidas</h3>
        <div className="profile-fixture-gates">
          {(["GET", "PUT", "refresh", "revoke"] as const).map((gate) => (
            <button
              type="button"
              key={gate}
              data-fixture-release={gate}
              disabled={state.pending[gate].length === 0}
              onClick={() => fixture.release(gate)}
            >
              Fixture: liberar {gate} ({state.pending[gate].length})
            </button>
          ))}
        </div>
        <p className="profile-fixture-readout">Pendientes: {JSON.stringify(state.pending)}</p>
      </section>

      <section className="profile-fixture-control-group" aria-labelledby="fixture-state-title">
        <h3 id="fixture-state-title">Fixture: resumen verificable</h3>
        <p className="profile-fixture-readout">
          Peticiones: {state.requestCount} ·{" "}
          {Object.entries(requestCounts)
            .map(([key, count]) => key + " × " + count)
            .join(" · ") || "todavía ninguna"}
        </p>
        <p className="profile-fixture-readout">
          Perfiles simulados:{" "}
          {(["A", "B"] as const)
            .map(
              (identity) => identity + (state.backend[identity].profile ? " guardado" : " vacío"),
            )
            .join(" · ")}
        </p>
        <details>
          <summary>Fixture: historial de peticiones sanitizado</summary>
          <div className="profile-fixture-request-list">
            {state.requests.length === 0 ? (
              <p>No hay peticiones todavía.</p>
            ) : (
              [...state.requests].reverse().map((request) => (
                <article className="profile-fixture-request" key={request.number}>
                  <strong>
                    {request.number}. {request.method} {request.path}
                  </strong>
                  <span>
                    identidad: {request.identity || "ninguna"} · bearer:{" "}
                    {request.authenticated ? "presente" : "ausente"} · HTTP: {request.status}
                  </span>
                  <span>{request.outcome}</span>
                  {request.body ? <code>{JSON.stringify(request.body)}</code> : null}
                </article>
              ))
            )}
          </div>
        </details>
        <details>
          <summary>Fixture: estado JSON legible</summary>
          <pre data-fixture="state-json" aria-label="Fixture: estado JSON sin credenciales">
            {JSON.stringify(state, null, 2)}
          </pre>
        </details>
      </section>

      <footer className="profile-fixture-footer">
        Fixture local y volátil: recargar esta página limpia sesiones, solicitudes y perfiles
        simulados. Usá datos ficticios en el formulario.
      </footer>
    </aside>
  );
}

function BrowserFixtureApp() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const updateHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, []);

  const getSession = useCallback(() => fixture.session, []);
  const route = useMemo(() => routeFromHash(hash), [hash]);
  const product = route ? (
    <AccountApp
      route={route}
      projectName={siteConfig.projectName}
      profileConfig={siteConfig.profile}
      getSession={getSession}
    />
  ) : (
    <PublicSite
      projectName={siteConfig.projectName}
      purpose={siteConfig.purpose}
      dataUse={siteConfig.dataUse}
    />
  );

  return (
    <div className="profile-fixture-layout">
      <div className="profile-fixture-product">{product}</div>
      <FixtureControls />
    </div>
  );
}

createRoot(rootElement).render(<BrowserFixtureApp />);
