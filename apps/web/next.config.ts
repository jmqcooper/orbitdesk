import type { NextConfig } from 'next';
import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';
const nextConfig: NextConfig = {
  transpilePackages: ['@orbitdesk/core'],
  serverExternalPackages: ['@prisma/client', 'pg-boss'],
  devIndicators: false,
};
// Railway supplies the values at boot, so nothing is frozen into the build.
export default varlockNextConfigPlugin({ freezeIntoBundle: false })(nextConfig);
