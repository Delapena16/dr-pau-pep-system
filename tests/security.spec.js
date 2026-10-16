const { test, expect } = require('@playwright/test');

test.describe('Security & MFA Flows', () => {

  test('2-Step MFA Login Modal & Flow', async ({ page }) => {
    test.setTimeout(60000); // 60s timeout due to mongoose buffering
    await page.goto('/');

    // Ensure we start logged out or can open login modal
    await page.click('button#openLoginModalBtn');
    await expect(page.locator('#mfaLoginModal')).toBeVisible();
    await expect(page.locator('#loginStepOneForm')).toBeVisible();

    await page.locator('button[data-demo-role="SuperAdmin"]').click();

    // Verify inputs populated
    await expect(page.locator('input#loginEmail')).toHaveValue('admin@drpauclinic.ph');

    // Submit Step 1
    await page.click('button:has-text("Verify Password")');

    // Wait for the mock to resolve. It sets a timeout, then fails, then falls back in demo mode.
    // That means it might take up to 10s for the Mongoose error, since our server tries to hit mongo.
    await expect(page.locator('#loginStepTwoForm')).not.toHaveClass(/hidden/, { timeout: 20000 });
    await expect(page.locator('#loginStepOneForm')).toHaveClass(/hidden/);

    // OTP should be auto-filled in the demo
    await expect(page.locator('input#loginOtpCode')).not.toBeEmpty();

    // Submit Step 2. Instead of finding by button text, let's find the submit button inside loginStepTwoForm
    await page.locator('#loginStepTwoForm button[type="submit"]').click();

    // Modal should close and UI should reflect logged in user
    await expect(page.locator('#mfaLoginModal')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('#currentUserBadge')).toContainText('SuperAdmin');
  });

  test('MFA fallback to Step 1', async ({ page }) => {
    test.setTimeout(60000); // 60s timeout due to mongoose buffering
    await page.goto('/');

    // Open login modal
    await page.click('button#openLoginModalBtn');

    // Fill required step 1 so it enables moving to step 2
    await page.fill('input#loginEmail', 'admin@drpauclinic.ph');
    await page.fill('input#loginPassword', 'Admin@12345');
    await page.click('button:has-text("Verify Password")');

    // Wait for Step 2
    await expect(page.locator('#loginStepTwoForm')).not.toHaveClass(/hidden/, { timeout: 20000 });

    // Click back to step 1
    await page.click('button#backToStepOneBtn');

    // Verify back on step 1
    await expect(page.locator('#loginStepOneForm')).not.toHaveClass(/hidden/);
    await expect(page.locator('#loginStepTwoForm')).toHaveClass(/hidden/);
  });
});
