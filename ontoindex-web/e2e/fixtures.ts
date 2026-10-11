import { test as base, expect } from '@playwright/test';

export { expect };
export { backendFetch } from './backend-auth';

export const test = base.extend({
  page: async ({ page }, use) => {
    const token = process.env.ONTOINDEX_HTTP_TOKEN?.trim();
    if (process.env.E2E && !token) throw new Error('E2E requires ONTOINDEX_HTTP_TOKEN');
    if (token) {
      const origin = new URL(process.env.FRONTEND_URL ?? 'http://localhost:5173').origin;
      await page.addInitScript(
        ({ origin, token }) => {
          if (window.location.origin === origin) {
            window.sessionStorage.setItem('ontoindex.httpToken', token);
          }
        },
        { origin, token },
      );
    }
    await use(page);
  },
});
