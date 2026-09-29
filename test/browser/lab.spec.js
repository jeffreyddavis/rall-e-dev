import { test, expect } from '@playwright/test';

test('text lab: a host plans by text and a friend RSVPs, suggests and chats', async ({ page }) => {
  test.skip(!process.env.RALLY_SMS_TEST_KEY, 'Only run against the isolated local preview with test credentials.');
  await page.goto('/lab');
  await page.getByLabel('SMS presenter password').fill(process.env.RALLY_SMS_TEST_KEY);
  await page.getByRole('button', { name: 'Open the text lab' }).click();
  await page.getByRole('button', { name: 'Clear these phones' }).click();
  const phone = name => page.getByRole('article', { name: `${name}'s phone` });
  const say = async (who, text) => { await phone(who).getByRole('textbox').fill(text); await phone(who).getByRole('button', { name: 'Send' }).click(); await expect(phone(who).getByText(text, { exact: true }).last()).toBeVisible(); };
  for (const t of ['Hi', 'Jeff', 'yes', '1', 'yes', 'Mike 310-555-0102, Dave 310-555-0103']) await say('You (host)', t);
  await expect(phone('Mike').getByText(/Jeff invited you to/)).toBeVisible();
  await say('Mike', 'yes');
  await expect(phone('You (host)').getByText(/Mike is in/)).toBeVisible();
  await say('Dave', 'how about comedy instead?');
  await expect(phone('Mike').getByText(/Reply VOTE 1/)).toBeVisible();
  await say('Mike', 'Running a bit late');
  await expect(phone('Dave').getByText('Mike: Running a bit late')).toBeVisible();
  await say('You (host)', 'CONFIRM');
  await expect(phone('Dave').getByText(/Jeff confirmed/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
