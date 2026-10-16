export type PublicSiteProps = {
  projectName: string;
  purpose: string;
  dataUse: string;
};

export function PublicSite({ projectName, purpose, dataUse }: PublicSiteProps) {
  return (
    <div className="site-shell">
      <header className="site-header">
        <p className="site-header__name">{projectName}</p>
        <span className="site-header__label">Información del proyecto</span>
      </header>

      <main>
        <section className="intro" aria-labelledby="project-title">
          <div className="intro__content">
            <p className="eyebrow">Conocé el proyecto</p>
            <h1 id="project-title">{projectName}</h1>
            <p className="intro__purpose">{purpose}</p>
          </div>
        </section>

        <section className="details" aria-labelledby="details-title">
          <div className="details__heading">
            <p className="eyebrow">Antes de comenzar</p>
            <h2 id="details-title">Lo que necesitás saber</h2>
          </div>
          <article className="detail-card" aria-labelledby="data-use-title">
            <span className="detail-card__number" aria-hidden="true">
              01
            </span>
            <div>
              <h3 id="data-use-title">Uso de datos</h3>
              <p>{dataUse}</p>
            </div>
          </article>
        </section>
      </main>

      <footer className="site-footer">
        <span>{projectName}</span>
        <span>Información pública</span>
      </footer>
    </div>
  );
}
