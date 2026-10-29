/**
 * Runs once when the Next.js server starts. It starts the shared-folder relay that the MT5 Expert Advisor talks to
 * (see lib/bridge/fileRelay.ts). Node runtime only: the relay needs the file system.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startFileRelay } = await import('./lib/bridge/fileRelay');
    startFileRelay();
  }
}
