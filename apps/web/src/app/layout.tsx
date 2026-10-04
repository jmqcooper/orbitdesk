import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Editorial pairing: a text serif with optical sizes for headings, a newsroom
// grotesque for the interface, and a mono for times, counts and identifiers.
const display = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  variable: '--font-display-face',
  display: 'swap',
});
const sans = Schibsted_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans-face',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono-face',
  display: 'swap',
});

const description =
  'Orbitdesk is an open-source assistant for Google Workspace: one inbox, calendar and task view across all your Google accounts, with an assistant that acts only after you approve.';

export const metadata: Metadata = {
  title: {
    default: 'Orbitdesk — one desk for every Google account',
    template: '%s · Orbitdesk',
  },
  description,
  applicationName: 'Orbitdesk',
  keywords: ['Google Workspace', 'Gmail', 'Google Calendar', 'Google Tasks', 'multiple accounts', 'AI assistant', 'open source'],
  openGraph: {
    type: 'website',
    siteName: 'Orbitdesk',
    title: 'Orbitdesk — one desk for every Google account',
    description,
  },
  twitter: {
    card: 'summary',
    title: 'Orbitdesk — one desk for every Google account',
    description,
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f4f0e7',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
