import type { Metadata } from 'next';
import Link from 'next/link';
import { OrbitMark } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="boot">
      <OrbitMark size={40} />
      <h1 className="boot__title">Nothing at this address</h1>
      <p className="boot__label">The page may have moved, or the link is incomplete.</p>
      <Link href="/" className="btn btn--primary">
        <span>Back to Orbitdesk</span>
      </Link>
    </div>
  );
}
