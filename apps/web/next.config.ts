import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@orbitdesk/core'],
  serverExternalPackages: ['@prisma/client', 'pg-boss'],
  devIndicators: false,
};
export default nextConfig;
