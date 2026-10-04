'use client';

import { ArrowRight, FlaskConical, Info, ShieldCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import type { AuthConfig } from '@/lib/types';
import type { AuthNotice } from './Boot';
import { OrbitMark, Spinner } from './ui';

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

interface OrbitSpec {
  rx: number;
  ry: number;
  tilt: number;
  seconds: number;
  bodies: Array<{ at: number; color: string; label: string; r: number }>;
}

const ORBITS: OrbitSpec[] = [
  { rx: 132, ry: 50, tilt: 16, seconds: 38, bodies: [{ at: 34, color: '#e39a2d', label: 'client', r: 6 }] },
  {
    rx: 206, ry: 84, tilt: -14, seconds: 56,
    bodies: [
      { at: 6, color: '#58b3a7', label: 'personal', r: 7 },
      { at: 55, color: '#7fa3d6', label: 'studio', r: 6 },
    ],
  },
  {
    rx: 280, ry: 122, tilt: 5, seconds: 82,
    bodies: [
      { at: 22, color: '#c98aa7', label: 'family', r: 5 },
      { at: 70, color: '#a9bf7a', label: 'board', r: 6 },
    ],
  },
];

function ellipsePath(rx: number, ry: number): string {
  return `M ${-rx} 0 a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
}

/** Decorative: several account "bodies" circling one desk. */
function OrbitDiagram() {
  return (
    <svg className="orbits" viewBox="-320 -220 640 440" role="img" aria-label="Several Google accounts orbiting one desk">
      <defs>
        <radialGradient id="orbit-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e39a2d" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#e39a2d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle r="150" fill="url(#orbit-glow)" />
      {ORBITS.map((orbit) => {
        const path = ellipsePath(orbit.rx, orbit.ry);
        return (
          <g key={orbit.rx} transform={`rotate(${orbit.tilt})`}>
            <path d={path} className="orbits__ring" />
            {orbit.bodies.map((body) => (
              <g
                key={body.label}
                className="orbits__body"
                style={{
                  offsetPath: `path('${path}')`,
                  animationDuration: `${orbit.seconds}s`,
                  animationDelay: `${-(orbit.seconds * body.at) / 100}s`,
                  offsetDistance: `${body.at}%`,
                }}
              >
                <g transform={`rotate(${-orbit.tilt})`}>
                  <circle r={body.r + 5} fill={body.color} opacity="0.16" />
                  <circle r={body.r} fill={body.color} />
                  <text x={body.r + 10} y="4" className="orbits__label">
                    {body.label}
                  </text>
                </g>
              </g>
            ))}
          </g>
        );
      })}
      <g>
        <circle r="44" className="orbits__desk" />
        <circle r="53" className="orbits__desk-ring" />
        <text y="7" textAnchor="middle" className="orbits__desk-label">
          desk
        </text>
      </g>
    </svg>
  );
}

const TENETS = [
  {
    no: '01',
    title: 'Mail, from the right account',
    body: 'One inbox across every identity. Each row and thread carries its account, and a reply always leaves from the mailbox it arrived in.',
  },
  {
    no: '02',
    title: 'A calendar that knows all of you',
    body: 'Week and agenda views across selected calendars. Availability is checked live, and an unreadable calendar is reported — never treated as free.',
  },
  {
    no: '03',
    title: 'Tasks where you keep them',
    body: 'Turn an email into a task in the Google list you choose, with a link back to its source. Google stays the source of truth.',
  },
  {
    no: '04',
    title: 'An assistant that asks first',
    body: 'It reads what you allow, shows its sources and its steps, and proposes exact actions. Nothing is sent, booked or deleted until you approve it.',
  },
];

export function Landing({
  auth,
  notice,
  onDismissNotice,
  onSignedIn,
}: {
  auth: AuthConfig;
  notice: AuthNotice | null;
  onDismissNotice: () => void;
  onSignedIn: () => void;
}) {
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<ApiRequestError | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const health = useResource('health', (signal) => api.health({ signal }));

  const startDemo = async () => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      await api.startDemo();
      onSignedIn();
    } catch (err) {
      setDemoError(toApiError(err));
      setDemoBusy(false);
    }
  };

  const healthLabel = health.loading
    ? 'Checking service status…'
    : health.data
      ? health.data.status === 'ok'
        ? 'All systems normal'
        : health.data.status === 'degraded'
          ? 'Service degraded'
          : 'Service unavailable'
      : 'Status unavailable';
  const healthTone = health.data ? health.data.status : health.loading ? 'pending' : 'unknown';

  return (
    <div className="landing">
      <header className="landing__bar">
        <Link href="/" className="wordmark" aria-label="Orbitdesk home">
          <OrbitMark size={26} />
          <span>Orbitdesk</span>
        </Link>
        <nav className="landing__nav" aria-label="Site">
          <span className="landing__tag">Open source</span>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <p className="kicker reveal" style={{ animationDelay: '40ms' }}>
              An assistant for Google Workspace{auth.inviteOnly ? ' · Invite-only beta' : ''}
            </p>
            <h1 className="hero__title reveal" style={{ animationDelay: '110ms' }}>
              Every Google account,
              <br />
              <em>one calm desk.</em>
            </h1>
            <p className="hero__lede reveal" style={{ animationDelay: '180ms' }}>
              Orbitdesk gathers the inboxes, calendars and task lists of all your Google identities into a single
              workspace — with an assistant that drafts, schedules and files only after you say yes.
            </p>

            {notice && (
              <div className={`notice notice--${notice.tone === 'danger' ? 'danger' : notice.tone === 'ok' ? 'ok' : 'info'} hero__notice`} role="alert">
                <Info size={16} aria-hidden="true" />
                <span className="notice__text">{notice.message}</span>
                <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss message" onClick={onDismissNotice}>
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="signin reveal" style={{ animationDelay: '250ms' }}>
              {auth.google.available ? (
                <a
                  className="google-btn"
                  href={googleAuthUrl('login')}
                  aria-busy={googleBusy || undefined}
                  onClick={() => setGoogleBusy(true)}
                >
                  {googleBusy ? <Spinner size={18} /> : <GoogleG />}
                  <span>Sign in with Google</span>
                </a>
              ) : (
                <button type="button" className="google-btn" disabled aria-describedby="google-unavailable">
                  <GoogleG />
                  <span>Sign in with Google</span>
                </button>
              )}
              {auth.google.available ? (
                <p className="signin__note">
                  {auth.inviteOnly
                    ? 'Invite-only beta — sign in with the Google account that was invited. '
                    : 'Signing in only identifies you. '}
                  You then connect each Google account inside, one consent screen at a time.
                </p>
              ) : (
                <p className="signin__note signin__note--warn" id="google-unavailable">
                  {auth.google.reason ?? 'Google sign-in is not configured on this deployment.'}
                </p>
              )}

              <div className="signin__or" aria-hidden="true">
                <span>or</span>
              </div>

              <div className="demo-box">
                <div className="demo-box__head">
                  <span className="demo-flag">
                    <FlaskConical size={13} aria-hidden="true" /> Sandbox demo
                  </span>
                  <span className="demo-box__sub">No Google account needed</span>
                </div>
                <p className="demo-box__text">
                  A private workspace of simulated accounts, mail and calendars. It never touches Google, never
                  delivers a message, and is deleted automatically after one day.
                </p>
                <button
                  type="button"
                  className="btn btn--primary demo-box__btn"
                  onClick={startDemo}
                  disabled={demoBusy || !auth.demo.available}
                  aria-describedby={auth.demo.available ? undefined : 'demo-unavailable'}
                >
                  {demoBusy ? <Spinner size={15} /> : null}
                  <span>{demoBusy ? 'Preparing your sandbox…' : 'Open the sandbox'}</span>
                  {!demoBusy && <ArrowRight size={16} aria-hidden="true" />}
                </button>
                {!auth.demo.available && (
                  <p className="signin__note signin__note--warn" id="demo-unavailable">
                    {auth.demo.reason ?? 'The sandbox demo is turned off on this deployment.'}
                  </p>
                )}
                {demoError && (
                  <p className="signin__note signin__note--warn" role="alert">
                    Could not start the sandbox: {demoError.message}{' '}
                    <span className="mono-note">({demoError.code})</span>
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="hero__art">
            <OrbitDiagram />
            <p className="hero__caption">
              <span>Fig. 1</span> Twelve inboxes and eight calendars are one person. Orbitdesk treats them that way.
            </p>
          </div>
        </section>

        <section className="tenets" aria-label="What Orbitdesk does">
          {TENETS.map((tenet) => (
            <article key={tenet.no} className="tenet">
              <span className="tenet__no">{tenet.no}</span>
              <h2 className="tenet__title">{tenet.title}</h2>
              <p className="tenet__body">{tenet.body}</p>
            </article>
          ))}
        </section>

        <section className="pledge" aria-label="How your data is handled">
          <ShieldCheck size={22} aria-hidden="true" />
          <div>
            <h2 className="pledge__title">Your Google data stays yours.</h2>
            <p className="pledge__body">
              Orbitdesk requests the narrowest Google permissions each feature needs, keeps a short-lived cache
              instead of a copy of your mailbox, blocks remote images by default, and deletes its data when you
              ask. Email content is treated as data: it can never grant itself permissions or instruct the
              assistant. Read the <Link href="/privacy">privacy policy</Link> for the details.
            </p>
          </div>
        </section>
      </main>

      <footer className="landing__foot">
        <span className="landing__copy">Orbitdesk · open-source assistant for Google Workspace</span>
        <span className={`health health--${healthTone}`} title={health.data ? `Version ${health.data.version}` : health.error?.message}>
          <span className="health__dot" aria-hidden="true" />
          {healthLabel}
        </span>
        <span className="landing__links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </span>
      </footer>
    </div>
  );
}
