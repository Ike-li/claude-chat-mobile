import { test, expect } from '@playwright/test';

test.describe('Playwright agent seed', () => {
  test('opens the P0 mock mobile chat shell', async ({ page }) => {
    await page.request.post('/__reset');
    await page.goto('/');
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeVisible();
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
  });
});
