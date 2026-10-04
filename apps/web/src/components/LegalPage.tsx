import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrbitMark } from './ui';

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** Shared layout for the privacy policy and terms: a contents rail and a reading column. */
export function LegalPage({
  kicker,
  title,
  updated,
  intro,
  sections,
}: {
  kicker: string;
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="legal">
      <header className="landing__bar">
        <Link href="/" className="wordmark" aria-label="Orbitdesk home">
          <OrbitMark size={26} />
          <span>Orbitdesk</span>
        </Link>
        <nav className="landing__nav" aria-label="Site">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/" className="btn btn--primary btn--sm">
            <span>Open Orbitdesk</span>
          </Link>
        </nav>
      </header>

      <main className="legal__main">
        <aside className="legal__toc" aria-label="On this page">
          <p className="kicker">On this page</p>
          <ol>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </aside>

        <article className="legal__article">
          <p className="kicker">{kicker}</p>
          <h1 className="legal__title">{title}</h1>
          <p className="legal__updated">Last updated {updated}</p>
          <div className="legal__intro">{intro}</div>
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} className="legal__section">
              <h2>
                <span className="legal__no">{String(index + 1).padStart(2, '0')}</span>
                {section.title}
              </h2>
              {section.body}
            </section>
          ))}
        </article>
      </main>

      <footer className="landing__foot">
        <span className="landing__copy">Orbitdesk · open-source assistant for Google Workspace</span>
        <span className="landing__links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </span>
      </footer>
    </div>
  );
}
