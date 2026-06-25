// Set BASE_PATH only if you serve the app under a sub-path (e.g. "/worldcup2026").
// Leave it unset to serve from the domain root (the default for most deployments).
const basePath = process.env.BASE_PATH || "";

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: false,
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  async redirects() {
    // Only needed when running under a sub-path: send the bare domain to the app.
    if (!basePath) return [];
    return [
      { source: "/", destination: basePath, basePath: false, permanent: false },
    ];
  },
};
