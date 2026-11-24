import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Discord adapter holds Discord's standing connection with discord.js, which loads optional native modules
  // by name: it runs from node_modules as it is, and isn't bundled.
  serverExternalPackages: ['@chat-adapter/discord'],
};

export default nextConfig;
