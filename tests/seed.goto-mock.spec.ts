import { expect, type Page } from '@playwright/test';

export function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (text.includes('Blocked call to navigator.vibrate')) return;
    if (text.includes('Failed to load resource: the server responded with a status of 404')) return;
    if (message.type() === 'error') errors.push(text);
  });
  (page as Page & { __ccmErrors?: string[] }).__ccmErrors = errors;
}

export async function gotoMock(page: Page) {
  captureBrowserErrors(page);
  await page.request.post('/__reset');
  await page.goto('/');
  await expect(page.locator('#input')).toBeVisible();
  await expect(page.locator('#btnSend')).toBeVisible();
  await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
}

export async function sendChatMessage(page: Page, text: string) {
  const input = page.locator('#input');
  await input.fill(text);
  await expect(page.locator('#btnSend')).toBeEnabled();
  await page.locator('#btnSend').click();
}

export async function waitForIdle(page: Page) {
  await expect(page.locator('#activeStatusPill')).toBeHidden({ timeout: 20_000 });
}

export async function expectNoBrowserErrors(page: Page) {
  const errors = (page as Page & { __ccmErrors?: string[] }).__ccmErrors || [];
  expect(errors).toEqual([]);
}
