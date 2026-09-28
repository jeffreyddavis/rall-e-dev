import { test, expect } from '@playwright/test';

test('SMS controls require presenter access and remain preview-only', async ({ page }) => {
  test.skip(!process.env.RALLY_SMS_TEST_KEY, 'Only run against the isolated local preview with test credentials.');
  await page.goto('/');
  await page.evaluate(async () => {
    const post = (path, data) => fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    await post('/api/session', {name:'SMS tester'});
    for (const data of [{action:'vibe',category:'dinner'}, {action:'accept'}, {action:'invite',names:['Tester']}]) await post('/api/action',data);
  });
  expect(await page.evaluate(async () => (await fetch('/api/sms/status')).status)).toBe(403);
  await page.reload(); await page.getByRole('button', {name:'Presenter controls'}).click();
  await page.getByRole('button', {name:'Text approved testers'}).click();
  await page.getByLabel('SMS presenter password').fill(process.env.RALLY_SMS_TEST_KEY);
  await page.getByRole('button', {name:'Open texting controls'}).click();
  await expect(page.getByText('PREVIEW ONLY · SENDING OFF', {exact:true})).toBeVisible();
  await page.getByLabel('Their phone number').fill('+15005550001');
  await page.getByRole('button', {name:'Preview this text'}).click();
  await expect(page.locator('.sms-body')).toContainText('Rall-e demo: SMS tester invited you');
  await page.getByRole('checkbox', {name:'This tester agreed'}).check();
  await expect(page.getByRole('button', {name:'Send this text',exact:true})).toBeDisabled();
  await expect(page.getByText('No send attempts for this plan.')).toBeVisible();
});
