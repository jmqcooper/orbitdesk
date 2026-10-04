import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@orbitdesk/core'],
  serverExternalPackages: ['@prisma/client', 'pg-boss'],
};
export default nextConfig;

