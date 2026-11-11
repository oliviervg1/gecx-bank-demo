import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function waitForPageTransitionSettled(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const main = document.getElementById('main-content')
        if (!main) return false
        const heading = main.querySelector('h1')
        if (!heading) return false
        const opacity = Number.parseFloat(window.getComputedStyle(heading).opacity)
        return Number.isFinite(opacity) && opacity >= 0.99
      }),
    )
    .toBe(true)
}

async function expectZeroAxeViolations(page: Page, contextLabel: string): Promise<void> {
  await waitForPageTransitionSettled(page)
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => ({
      target: n.target,
      failureSummary: n.failureSummary,
    })),
  }))
  expect(summary, `Expected 0 WCAG 2.1 AA violations on ${contextLabel}`).toEqual([])
}

test.describe('Cloudbank live proxy E2E and WCAG 2.1 AA suite', () => {
  test('syncs Tier 1 ui_view_state, numerical screen/speech parity, live announcements, sandboxed search chips, and GoAway resume', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('Cloudbank — Home')

    const pill = page.locator('[data-concierge-pill="true"]')
    await expect(pill).toContainText('Hold to talk')

    const input = page.getByLabel('Ask your Cloudbank concierge')
    await input.fill('Which recurring subscriptions am I paying for, and how do I cancel Netflix?')
    await page.getByRole('button', { name: 'Send message' }).click()

    // Tier 1 ServerUiState navigates from Home to Spending -> Subscriptions and highlights Netflix.
    const spendingTab = page
      .getByRole('navigation', { name: 'Primary banking navigation' })
      .getByRole('button', { name: 'Spending' })
    await expect(spendingTab).toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveTitle('Cloudbank — Spending')
    await expect(page.getByRole('heading', { name: 'Spending › Subscriptions' })).toBeVisible()

    // Left-pane figures match canonical chloe.json (£1,731.90 across 6 recurring charges, Netflix £45.00).
    const bankingPane = page.getByRole('region', { name: 'Cloudbank Personal Banking' })
    await expect(bankingPane).toContainText('£1,731.90')
    await expect(bankingPane).toContainText('6 recurring charges')

    const netflixRow = page.locator('[data-highlighted="true"]').filter({ hasText: 'Netflix' })
    await expect(netflixRow).toBeVisible()
    await expect(netflixRow).toContainText('£45.00')

    // Polite live-region announcers update once with clean sanitized text (no <warm> or <positive> tags)
    // and exact numerical parity with the left-hand screen.
    await expect(page.getByTestId('ui-navigation-announcer')).toHaveText(
      'Showing Spending: Subscriptions',
    )
    await expect(page.getByTestId('concierge-turn-announcer')).toContainText(
      'Cloudbank Concierge: You have 6 recurring charges this month totalling £1,731.90, including Netflix at £45.00.',
    )
    await expect(page.getByTestId('concierge-turn-announcer')).not.toContainText('<warm>')
    await expect(page.getByTestId('concierge-turn-announcer')).not.toContainText('<positive>')
    await expect(page.getByTestId('active-specialist-pill')).toHaveText('Everyday Banking')

    // Sandboxed Google Search web-result suggestions iframe + validated official help citation chip.
    const searchBlock = page.getByTestId('search-suggestions-block')
    await expect(searchBlock).toBeVisible()
    await expect(searchBlock).toContainText('Web search results')
    const suggestionIframe = searchBlock.locator(
      'iframe[title="Google Search web result suggestion 1"]',
    )
    await expect(suggestionIframe).toBeVisible()
    await expect(suggestionIframe).toHaveAttribute(
      'sandbox',
      'allow-popups allow-popups-to-escape-sandbox',
    )
    const citationLink = searchBlock.getByRole('link', { name: /How to cancel Netflix/i })
    await expect(citationLink).toHaveAttribute('href', 'https://help.netflix.com/en/node/407')

    // ServerGoAway seamless session resume preserving turns and monotonic lastUiSeq cursor.
    await input.fill('trigger goaway')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByRole('heading', { name: 'Home Emergency Pot' })).toBeVisible()
    await expect(page).toHaveTitle('Cloudbank — Savings')
    await expect(pill).toContainText('Hold to talk')
    await expect(page.getByTestId('turn-assistant')).toHaveCount(2)

    await input.fill('confirm resumed')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByRole('heading', { name: 'Your Mortgage' })).toBeVisible()
    await expect(page).toHaveTitle('Cloudbank — Mortgage')
    await expect(page.getByRole('tab', { name: 'Fixed Rates' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('renders card-freeze Toast strictly inside viewport bounds on Profile page', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-concierge-pill="true"]')).toContainText('Hold to talk')

    await page
      .getByRole('navigation', { name: 'Primary banking navigation' })
      .getByRole('button', { name: 'Profile' })
      .click()
    await expect(page.getByRole('heading', { name: 'Chloe Williams' })).toBeVisible()

    await page.getByRole('button', { name: 'Freeze card' }).click()

    const toast = page.locator('[data-toast]')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Your debit card is frozen.')

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    const box = await toast.boundingBox()
    expect(box).not.toBeNull()
    if (viewport && box) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.width).toBeGreaterThan(0)
      expect(box.height).toBeGreaterThan(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    }

    await page.getByRole('button', { name: 'Unfreeze' }).click()
    await expect(toast).toContainText('Your debit card is unfrozen.')
  })

  test('supports SkipLink, SegmentedTabs roving tabIndex, PTT toggle-to-talk, ?ptt=0 continuous mode, and sign-out', async ({
    page,
  }) => {
    await page.goto('/')
    const pill = page.locator('[data-concierge-pill="true"]')
    await expect(pill).toContainText('Hold to talk')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')

    // 1. SkipLink focus jump to #main-content
    await page.keyboard.press('Tab')
    const skipLink = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skipLink).toBeFocused()
    await page.keyboard.press('Enter')
    const focusedMainId = await page.evaluate(() => document.activeElement?.id ?? '')
    expect(focusedMainId).toBe('main-content')

    // 2. SegmentedTabs ArrowRight / ArrowLeft / Home / End roving tabIndex on Mortgage page
    await page
      .getByRole('navigation', { name: 'Primary banking navigation' })
      .getByRole('button', { name: 'Mortgage' })
      .click()
    const overviewTab = page.getByRole('tab', { name: 'Overview' })
    const overpayTab = page.getByRole('tab', { name: 'Overpay' })
    const ratesTab = page.getByRole('tab', { name: 'Fixed Rates' })

    await expect(overviewTab).toHaveAttribute('aria-selected', 'true')
    await expect(overviewTab).toHaveAttribute('tabindex', '0')
    await expect(overpayTab).toHaveAttribute('tabindex', '-1')
    await expect(ratesTab).toHaveAttribute('tabindex', '-1')

    await overviewTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(overpayTab).toBeFocused()
    await expect(overpayTab).toHaveAttribute('aria-selected', 'true')
    await expect(overpayTab).toHaveAttribute('tabindex', '0')
    await expect(overviewTab).toHaveAttribute('tabindex', '-1')

    await page.keyboard.press('End')
    await expect(ratesTab).toBeFocused()
    await expect(ratesTab).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Home')
    await expect(overviewTab).toBeFocused()
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowLeft')
    await expect(ratesTab).toBeFocused()
    await expect(ratesTab).toHaveAttribute('aria-selected', 'true')

    // 3. Click and Enter toggle-to-talk on ConciergePill toggling aria-pressed;
    //    spoken replies suppress concierge-turn-announcer so screen readers do not talk over TTS.
    await pill.click()
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(pill).toContainText('Release to send')
    await pill.click()
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
    await expect(pill).toContainText('Hold to talk', { timeout: 10_000 })
    await expect(page.getByTestId('conversation-stream')).toContainText('£4,250.75')
    await expect(page.getByTestId('concierge-turn-announcer')).toHaveText('')

    // Wait briefly so the wire audio gap (>450 ms) arms the next voice utterance
    await page.waitForTimeout(550)
    await pill.focus()
    await page.keyboard.press('Enter')
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(pill).toContainText('Release to send')
    await page.keyboard.press('Enter')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
    await expect(pill).toContainText('Hold to talk', { timeout: 10_000 })

    // 4. "Log out securely" clears transcript turns and locks tabs until "Sign back in"
    await page
      .getByRole('navigation', { name: 'Primary banking navigation' })
      .getByRole('button', { name: 'Profile' })
      .click()
    await page.getByRole('button', { name: 'Log out securely' }).click()

    await expect(page.getByTestId('signed-out-screen')).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Primary banking navigation' }),
    ).toHaveCount(0)
    await expect(pill).toHaveCount(0)

    await page.getByRole('button', { name: 'Sign back in' }).click()
    await expect(page.getByTestId('signed-out-screen')).toHaveCount(0)
    await expect(
      page.getByRole('navigation', { name: 'Primary banking navigation' }),
    ).toBeVisible()
    await expect(page.getByTestId('turn-user')).toHaveCount(0)
    await expect(page.getByTestId('turn-assistant')).toHaveCount(0)
    await expect(pill).toContainText('Hold to talk')

    // 5. ?ptt=0 continuous listening returns to "Listening" after agent audio reply and stops cleanly on click
    await page.goto('/?ptt=0')
    await expect(pill).toContainText('Talk to concierge')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')

    await pill.click()
    await expect(pill).toContainText('Listening')
    await expect(pill).toHaveAttribute('aria-pressed', 'true')

    // Hands-free AudioWorklet streams PCM -> FakeBidiUpstream replies with 24 kHz TTS audio + text ->
    // AudioPlayer drains and continuous mode returns automatically to "Listening".
    await expect(page.getByTestId('conversation-stream')).toContainText(
      'Your current account balance is £4,250.75.',
      { timeout: 10_000 },
    )
    await expect(pill).toContainText('Listening', { timeout: 10_000 })
    await expect(pill).toHaveAttribute('aria-pressed', 'true')

    // Clicking "Listening" stops continuous capture cleanly back to ready.
    await pill.click()
    await expect(pill).toContainText('Talk to concierge')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
  })

  test('keeps mobile concierge chat open across cross-page ServerUiState navigation and closes on Escape', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?layout=mobile')
    await expect(page.locator('[data-concierge-pill="true"]')).toContainText('Hold to talk')

    const mobileToggle = page.getByTestId('mobile-concierge-toggle')
    await mobileToggle.click()
    const drawer = page.getByTestId('mobile-concierge-drawer')
    await expect(drawer).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Cloudbank Concierge' }),
    ).toBeVisible()

    // Ask a question that triggers cross-page Home -> Spending navigation: drawer MUST stay open!
    const input = drawer.getByLabel('Ask your Cloudbank concierge')
    await input.fill('Which recurring subscriptions am I paying for, and how do I cancel Netflix?')
    await drawer.getByRole('button', { name: 'Send message' }).click()

    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('£1,731.90')
    await expect(drawer).toContainText('£45.00')
    await expect(page).toHaveTitle('Cloudbank — Spending')

    // Pressing Escape closes the mobile drawer, reveals Spending › Subscriptions, and restores focus.
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(mobileToggle).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Spending › Subscriptions' })).toBeVisible()
  })

  test('passes WCAG 2.1 AA axe-core scans across all 5 tabs, SVG charts, renter Tom, and Mobile View', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.locator('[data-concierge-pill="true"]')).toContainText('Hold to talk')

    const primaryNav = page.getByRole('navigation', { name: 'Primary banking navigation' })

    // 1. Home
    await expectZeroAxeViolations(page, 'Split Workbench - Home (Chloe)')

    // 2. Spending: Overview, Subscriptions, 3-Month Trend SVG chart, and Category Drilldown SVG chart
    await primaryNav.getByRole('button', { name: 'Spending' }).click()
    await expect(page.getByRole('heading', { name: 'Spending' })).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Spending Overview')

    await page.getByRole('tab', { name: 'Subscriptions' }).click()
    await expect(page.getByRole('heading', { name: 'Spending › Subscriptions' })).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Spending Subscriptions')

    await page.getByRole('tab', { name: '3-Month Trend' }).click()
    await expect(page.getByText('Three-Month Statement Comparison', { exact: true })).toBeVisible()
    await expect(page.locator('svg[role="img"]')).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Spending 3-Month Trend SVG Chart')

    await page.getByRole('tab', { name: 'Overview' }).click()
    await page.getByRole('button', { name: /^Groceries\s+£/ }).click()
    await expect(page.getByRole('heading', { name: 'Spending › Groceries' })).toBeVisible()
    await expect(page.locator('svg[role="img"]')).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Spending Category Drilldown SVG Chart')

    // 3. Savings
    await primaryNav.getByRole('button', { name: 'Savings' }).click()
    await expect(page.getByRole('heading', { name: 'Home Emergency Pot' })).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Savings')

    // 4. Mortgage (Homeowner Chloe: Overview, Overpay, Fixed Rates + Renter Tom)
    await primaryNav.getByRole('button', { name: 'Mortgage' }).click()
    await expect(page.getByRole('heading', { name: 'Your Mortgage' })).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Mortgage Overview (Homeowner)')

    await page.getByRole('tab', { name: 'Overpay' }).click()
    await expectZeroAxeViolations(page, 'Split Workbench - Mortgage Overpay (Homeowner)')

    await page.getByRole('tab', { name: 'Fixed Rates' }).click()
    await expectZeroAxeViolations(page, 'Split Workbench - Mortgage Fixed Rates (Homeowner)')

    // Switch persona to Tom (Renter) and scan Renter Borrowing Readiness view
    await page.locator('button[data-persona-id="tom"]').click()
    await expect(page.getByTestId('renter-readiness-view')).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Mortgage Renter Readiness (Tom)')

    // 5. Profile (including live Toast)
    await primaryNav.getByRole('button', { name: 'Profile' }).click()
    await expect(page.getByRole('heading', { name: 'Tom Harding' })).toBeVisible()
    await page.getByRole('button', { name: 'Freeze card' }).click()
    await expect(page.locator('[data-toast]')).toBeVisible()
    await expectZeroAxeViolations(page, 'Split Workbench - Profile with Active Toast')

    // 6. Mobile View (?layout=mobile): Banking view + Mobile Concierge Drawer
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?layout=mobile')
    await expect(page.getByRole('navigation', { name: 'Workbench view controls' })).toBeVisible()
    await expectZeroAxeViolations(page, 'Mobile View (?layout=mobile) - Home')

    await page.getByTestId('mobile-concierge-toggle').click()
    await expect(page.getByTestId('mobile-concierge-drawer')).toBeVisible()
    await expectZeroAxeViolations(page, 'Mobile View (?layout=mobile) - Concierge Drawer')
  })
})
