const { test, expect } = require('@playwright/test');

test.describe('Clinic Core Flows', () => {

  test('Receptionist Walk-In Registration Flow', async ({ page }) => {
    await page.goto('/');

    // Ensure Receptionist Panel is active
    await page.click('text=1. Receptionist Panel');
    await expect(page.locator('text=Walk-In Animal Bite Registration').first()).toBeVisible();

    // Fill registration form
    await page.fill('input#patientFullName', 'Juan Dela Cruz');
    await page.fill('input#patientAge', '30');
    await page.selectOption('select#patientSex', 'Male');
    await page.fill('input#patientContact', '09123456789');

    await page.selectOption('select#patientBarangay', 'Brgy. Commonwealth');
    await page.selectOption('select#animalType', 'Dog');
    await page.selectOption('select#animalOwnershipStatus', 'Stray / Wild');
    await page.fill('input#biteSite', 'Left Leg');
    await page.selectOption('select#exposureType', 'Bite (Transdermal / Skin Break)');

    // Check wound washed checkbox if it exists. Looking at index.html, it's:
    // <input type="checkbox" id="woundWashingDone" required>
    if (await page.locator('input#woundWashingDone').isVisible()) {
        await page.check('input#woundWashingDone');
    }

    // Submit form
    await page.click('button:has-text("+ Register Walk-In Patient")');

    // Wait for the UI to update
    await page.waitForTimeout(500);

    // Verify patient appears in the queue
    await expect(page.locator('td:has-text("Juan Dela Cruz")').first()).toBeVisible();
  });

  test('Physician Clinical Triage Flow', async ({ page }) => {
    await page.goto('/');

    // Switch to Physician Panel
    await page.click('text=2. Physician Panel');
    await expect(page.locator('text=Clinical Triage & PEP Schedule Generator').first()).toBeVisible();

    // Select the first real patient
    const patientSelect = page.locator('select#triagePatientSelect');

    // Wait for options
    await page.waitForTimeout(500);
    await patientSelect.selectOption({ index: 1 });

    await page.selectOption('select#triageWhoCategory', 'Category III');
    // For RIG administered it looks like a checkbox
    if (await page.locator('input#triageRigAdministered').isVisible()) {
        await page.check('input#triageRigAdministered');
    }

    // Clinical notes is not named triageClinicalNotes, looking at app.js:
    // const notes = document.getElementById('triageClinicalNotes').value.trim();
    // In index.html it is actually an input type="text"
    await page.fill('input#triageClinicalNotes', 'Deep puncture wound. RIG administered.');

    // Submit triage
    await page.click('button:has-text("Save WHO Classification")');

    // Verify UI updates
    await page.waitForTimeout(500);
  });

  test('Super Admin Inventory Restock Flow', async ({ page }) => {
    await page.goto('/');

    // Switch to Super Admin Panel
    await page.click('text=3. Super Admin Panel');
    await expect(page.locator('text=Cold-Chain Vaccine & RIG Inventory').first()).toBeVisible();

    // Fill inventory form
    await page.fill('input#invItemName', 'Speeda (Freeze-Dried Rabies Vaccine)');
    await page.selectOption('select#invCategory', 'Anti-Rabies Vaccine (ARV)');
    await page.fill('input#invBatchNumber', 'TEST-BATCH-001');
    await page.fill('input#invVials', '50');
    await page.fill('input#invDosesPerVial', '5');
    await page.fill('input#invExpirationDate', '2028-12-31');

    // Submit restock
    await page.click('button:has-text("+ Restock Cold-Chain Batch")');

    // Wait for UI to update
    await page.waitForTimeout(500);

    // Verify batch in table
    await expect(page.locator('td:has-text("TEST-BATCH-001")').first()).toBeVisible();
  });

});
