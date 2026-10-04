'use client';

import { OrbitMark } from '@/components/ui';

// Last-resort boundary for a rendering fault in the client app.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="boot" role="alert">
      <OrbitMark size={40} />
      <h1 className="boot__title">Orbitdesk hit a problem on this screen</h1>
      <p className="boot__label">
        Nothing was sent or changed by this error. Reload the view; if it keeps happening, the detail below helps whoever
        runs this deployment.
      </p>
      <p className="errstate__code">{error.digest ? `${error.name} · ${error.digest}` : error.message || error.name}</p>
      <button type="button" className="btn btn--primary" onClick={reset}>
        <span>Reload this view</span>
      </button>
    </div>
  );
}
