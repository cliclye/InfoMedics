// Loads ./.env (if present) before anything else reads process.env. Import this first.
// Tests (node --test) never load it, so a real API key on a developer's machine can't leak into a test run.
if (!process.env.NODE_TEST_CONTEXT) {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch {
    // no .env file: that's fine, real environment variables still work
  }
}
