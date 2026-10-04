import OrbitdeskApp from '@/components/OrbitdeskApp';

// The shell is static; everything user-specific is fetched by the client from /api
// with the session cookie, so no account data is ever rendered into cached HTML.
export default function Page() {
  return <OrbitdeskApp />;
}
