export async function loadChromium() {
  try { return (await import('playwright')).chromium; }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('This command requires Playwright. Install it with npm install playwright.');
  }
}
