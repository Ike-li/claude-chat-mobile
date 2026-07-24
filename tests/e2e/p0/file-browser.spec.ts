// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { expectSidebarClosed, openSessionsSidebar } from '../../helpers/p0-ui';

// CM5 官方约定：编辑器容器 DOM 节点挂 .CodeMirror 反向引用指回实例——不用给 app.js 加测试专用钩子。
// 只测我方保存/取消/冲突接线，不测 CM5 自己的键入渲染（那是 vendor 库的事，已有上游测试）。
async function setCmValue(page: Page, value: string) {
  await page.evaluate((v) => {
    const wrapper = document.querySelector('#fileBrowseBody .CodeMirror') as (Element & { CodeMirror?: { setValue: (s: string) => void } }) | null;
    wrapper?.CodeMirror?.setValue(v);
  }, value);
}
async function getCmValue(page: Page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('#fileBrowseBody .CodeMirror') as (Element & { CodeMirror?: { getValue: () => string } }) | null;
    return wrapper?.CodeMirror?.getValue() ?? null;
  });
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-21 顶部工作区入口打开文件浏览且侧栏不重复提供入口', async ({ page }) => {
    await gotoMock(page);

    // pill → chooser → 浏览项目文件
    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceChooserModal')).toBeVisible();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();

    await expect(page.locator('#fileBrowseModal')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).not.toHaveText('');
    await expectSidebarClosed(page);

    await page.locator('#fileBrowseClose').click();
    await expect(page.locator('#fileBrowseModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel button[title*="浏览项目文件"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-21b 小文件用 CodeMirror 高亮查看，截断的大文件回退纯文本', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await expect(page.locator('#fileBrowseModal')).toBeVisible();

    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();
    await expect(page.locator('#fileBrowseBody .cm-keyword').first()).toContainText('function');
    // 直接子元素 pre 才是回退纯文本路径的标记；CM5 内部渲染每行也用 <pre class="CodeMirror-line">，不能混判。
    await expect(page.locator('#fileBrowseBody > pre')).toHaveCount(0);

    await page.locator('#fileBrowseBack').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'huge.log' }).click();
    await expect(page.locator('#fileBrowseBody > pre')).toBeVisible();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-EDIT 编辑并保存，重新打开后内容确实持久化', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();

    const editBtn = page.locator('#fileBrowseEdit');
    const saveBtn = page.locator('#fileBrowseSave');
    const cancelBtn = page.locator('#fileBrowseCancelEdit');
    await expect(editBtn).toBeVisible();
    await expect(saveBtn).toBeHidden();
    await expect(cancelBtn).toBeHidden();

    await editBtn.click();
    await expect(editBtn).toBeHidden();
    await expect(saveBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();

    await setCmValue(page, 'function greet(name) {\n  return `Hi, ${name}!`;\n}\n');
    await saveBtn.click();

    // 保存成功回到「编辑」态、无错误横幅。
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await expect(saveBtn).toBeHidden();
    await expect(page.locator('[data-testid="file-save-error"]')).toBeHidden();

    // 退出再重新进入同一文件：内容应是刚保存的新内容（不是加载时的旧内容）——验证真落盘持久化。
    await page.locator('#fileBrowseBack').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();
    await expect.poll(() => getCmValue(page)).toContain('Hi, ${name}');

    await expectNoBrowserErrors(page);
  });

  test('P0-EDITb 取消编辑丢弃改动，CM 内容还原', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();

    const original = await getCmValue(page);
    await page.locator('#fileBrowseEdit').click();
    await setCmValue(page, '// discarded edit, should never be saved\n');
    await page.locator('#fileBrowseCancelEdit').click();

    await expect(page.locator('#fileBrowseEdit')).toBeVisible();
    await expect(page.locator('#fileBrowseSave')).toBeHidden();
    await expect.poll(() => getCmValue(page)).toBe(original);

    await expectNoBrowserErrors(page);
  });

  test('P0-EDITd 编辑态退出（返回/关闭/点背景）未保存改动需二次确认，取消确认不丢改动', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();

    await page.locator('#fileBrowseEdit').click();
    await setCmValue(page, '// unsaved edit, should survive a cancelled discard\n');

    // 返回按钮：弹确认，点「取消」应留在编辑态且改动还在。
    await page.locator('#fileBrowseBack').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expect(page.locator('#fileBrowseSave')).toBeVisible();
    await expect.poll(() => getCmValue(page)).toContain('unsaved edit');

    // 再点返回，这次确认放弃：应真的丢弃改动、回到列表视图。
    await page.locator('#fileBrowseBack').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();
    await expect(page.locator('#fileBrowseModal')).toBeVisible(); // 仍在浏览器 sheet 内，只是回到列表
    await expect(page.locator('[data-testid="browse-entry"]').first()).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#fileBrowseEdit')).toBeHidden(); // 编辑按钮组是 content 视图独有，回列表应隐藏

    // 关闭按钮同款守卫：重新进编辑态改动后点关闭 → 确认 → sheet 真的关闭。
    await page.locator('[data-testid="browse-entry"]', { hasText: 'demo.js' }).click();
    await page.locator('#fileBrowseEdit').click();
    await setCmValue(page, '// another unsaved edit\n');
    await page.locator('#fileBrowseClose').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();
    await expect(page.locator('#fileBrowseModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-EDITc 保存冲突时显示错误、不丢改动、仍留在编辑态', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await page.locator('[data-testid="browse-entry"]', { hasText: 'conflict.js' }).click();
    await expect(page.locator('#fileBrowseBody .cm-ccm-viewer .CodeMirror')).toBeVisible();

    await page.locator('#fileBrowseEdit').click();
    await setCmValue(page, 'const x = 999; // my unsaved edit\n');
    await page.locator('#fileBrowseSave').click();

    const errorBanner = page.locator('[data-testid="file-save-error"]');
    await expect(errorBanner).toBeVisible({ timeout: 5_000 });
    await expect(errorBanner).toContainText('已被修改');
    // 冲突不是「保存成功」，必须仍留在编辑态——用户的改动还在，可以选择手动处理（如复制走再刷新）。
    await expect(page.locator('#fileBrowseSave')).toBeVisible();
    await expect(page.locator('#fileBrowseEdit')).toBeHidden();
    await expect.poll(() => getCmValue(page)).toContain('my unsaved edit');

    await expectNoBrowserErrors(page);
  });
});
