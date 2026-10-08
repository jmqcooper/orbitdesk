import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import '@/styles/base.css';
import '@/styles/shell.css';
import '@/styles/mail.css';
import '@/styles/agent.css';
import '@/styles/views.css';
import '@/styles/pages.css';

// One crisp grotesque for everything, and a mono for shortcuts and identifiers.
const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans-face',
  display: 'swap',
});
const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono-face',
  display: 'swap',
});

const description =
  'Orbitdesk sorts the mail from every Google account you have, drafts the replies in your voice, and keeps your calendars and tasks beside it. Nothing is sent until you say so.';

export const metadata: Metadata = {
  title: {
    default: 'Orbitdesk — your inbox, already handled',
    template: '%s · Orbitdesk',
  },
  description,
  applicationName: 'Orbitdesk',
  keywords: ['Google Workspace', 'Gmail', 'Google Calendar', 'Google Tasks', 'multiple accounts', 'email agent', 'open source'],
  openGraph: {
    type: 'website',
    siteName: 'Orbitdesk',
    title: 'Orbitdesk — your inbox, already handled',
    description,
  },
  twitter: {
    card: 'summary',
    title: 'Orbitdesk — your inbox, already handled',
    description,
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1012' },
  ],
};

// Runs before first paint so the stored or system theme never flashes the other one.
const themeScript = `try{var t=localStorage.getItem('orbitdesk:theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
