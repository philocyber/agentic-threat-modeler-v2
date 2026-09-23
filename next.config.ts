import type { NextConfig } from "next";

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
]

const nextConfig: NextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['127.0.2.2'],
  experimental: {
    // Turbopack reached a multi-gigabyte native footprint during long-lived
    // local scans. Development uses Webpack so compilation stays isolated from
    // the sibling pipeline-worker process.
    webpackMemoryOptimizations: true,
  },
  // Chroma ships optional embedding providers and non-code assets that
  // Turbopack otherwise tries to compile. The app uses Chroma only as a
  // server-side HTTP client, so keep the package external to the Next bundle.
  serverExternalPackages: [
    'better-sqlite3',
    'chromadb',
    '@langchain/aws',
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/credential-provider-node',
    '@cursor/sdk',
  ],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig;
