import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The adapter runs from node_modules as it is, and isn't bundled: it may load parts of itself by name.
  serverExternalPackages: ['@chat-adapter/telegram'],
};

export default nextConfig;
