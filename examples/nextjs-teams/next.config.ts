import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Teams adapter is built on Microsoft's Teams SDK, which loads parts of itself by name: it runs from
  // node_modules as it is, and isn't bundled.
  serverExternalPackages: ['@chat-adapter/teams'],
};

export default nextConfig;
