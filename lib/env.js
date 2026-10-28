// Loads ./.env (if present) before anything else reads process.env. Import this first.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // no .env file: that's fine, real environment variables still work
}
