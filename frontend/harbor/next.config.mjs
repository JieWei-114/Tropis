/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output → a self-contained Node server for a small Docker image
  // (the public site is SSR, unlike helm which ships as static nginx).
  output: 'standalone',
};

export default nextConfig;
