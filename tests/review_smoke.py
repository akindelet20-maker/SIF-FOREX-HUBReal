import json
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:4174'
OUT = Path(__file__).resolve().parents[1]

SUPABASE_STUB = r'''export function createClient() {
  const profile = window.__reviewProfile || { full_name: 'Review Trader', username: 'review_user', membership: 'free' };
  return {
    auth: {
      getUser: async () => ({ data: { user: window.__reviewUser || null }, error: null }),
      getSession: async () => ({ data: { session: window.__reviewUser ? { user: window.__reviewUser } : null }, error: null }),
      onAuthStateChange: (callback) => { window.__reviewAuthCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async (credentials) => { window.__reviewLoginEmail = credentials.email; return { data: { user: window.__reviewUser || { id: 'review-user' }, session: { access_token: 'review-only' } }, error: null }; },
      signUp: async (payload) => { window.__reviewSignup = payload; return { data: { user: null, session: null }, error: null }; },
      resetPasswordForEmail: async (email) => { window.__reviewResetEmail = email; return { data: {}, error: null }; },
      signOut: async () => ({ error: null })
    },
    from: (table) => {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: table === 'academy_progress' ? (window.__reviewProgress || null) : profile, error: null }),
        upsert: async (payload) => { window.__reviewUpsert = { table, payload }; return { error: null }; }
      };
      return query;
    }
  };
}'''


def stub_supabase(context):
    context.route(
        'https://esm.sh/@supabase/supabase-js@2',
        lambda route: route.fulfill(
            status=200,
            content_type='text/javascript',
            headers={'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'},
            body=SUPABASE_STUB,
        ),
    )


def set_test_user(context, uid='review-user'):
    context.add_init_script(f'''window.__reviewUser = {{ id: {uid!r}, email: 'review@example.test', user_metadata: {{ full_name: 'Review Trader', username: 'review_user' }} }};
window.__reviewProfile = {{ full_name: 'Review Trader', username: 'review_user', membership: 'free' }};''')


def close_alert(page):
    page.once('dialog', lambda dialog: dialog.accept())


def assert_no_horizontal_overflow(page, label):
    width = page.evaluate('document.documentElement.scrollWidth')
    viewport = page.evaluate('window.innerWidth')
    assert width <= viewport + 1, f'{label} horizontal overflow: document={width}px viewport={viewport}px'


def main():
    page_errors = []
    checks = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
        ctx = browser.new_context(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
        stub_supabase(ctx)
        page = ctx.new_page()
        page.on('pageerror', lambda error: page_errors.append(str(error)))

        # Homepage navigation and TradingView chart selection.
        page.goto(BASE + '/index.html', wait_until='domcontentloaded')
        expect(page.locator('.hero h1')).to_be_visible()
        expect(page.locator('#nav-login')).to_have_text('Login')
        expect(page.locator('#nav-register')).to_be_visible()
        expect(page.locator('#pair-selector')).to_be_visible()
        expect(page.frame_locator('.dashboard-chart iframe').locator('body')).to_contain_text('Indicative data', timeout=20000)
        page.screenshot(path=str(OUT / 'review-homepage-desktop.png'), full_page=True)
        page.locator('#pair-selector').select_option('FX:GBPUSD')
        expect(page.locator('#market-provider')).to_contain_text('FX:GBPUSD')
        expect(page.locator('.dashboard-chart iframe')).to_have_attribute('src', re.compile('GBPUSD'), timeout=5000)
        expect(page.locator('.price-button.is-disabled')).to_have_count(2)
        expect(page.locator('.feature-card:has-text("Strategy Tester") .coming-soon-label')).to_be_visible()
        checks.append('homepage, rendered TradingView feed disclaimer, pair selector, and disabled membership states')

        # Academy: complete curriculum manifest, lazy-loaded lesson, separate assessment link, and locked progression.
        page.goto(BASE + '/academy.html', wait_until='domcontentloaded')
        expect(page.locator('#module-grid .module-card')).to_have_count(18)
        expect(page.locator('#module-grid .module-lesson-row')).to_have_count(206)
        expect(page.locator('#course-progress-count')).to_contain_text('0 of 206')
        page.screenshot(path=str(OUT / 'review-academy-desktop.png'), full_page=True)
        with page.expect_response(re.compile(r'academy-content/module-01\.json')) as lesson_response:
            page.locator('#module-1 [data-open-lesson="m1-l1"]').click()
        assert lesson_response.value.status == 200
        expect(page.locator('#lesson-title')).to_have_text('What is Forex Trading?')
        expect(page.locator('.lesson-assessment-link')).to_be_visible()
        expect(page.locator('.lesson-assessment-link a')).to_have_attribute('href', 'sif-question.html?lesson=m1-l1')
        expect(page.locator('.quiz-question')).to_have_count(0)
        page.screenshot(path=str(OUT / 'review-academy-lesson.png'), full_page=True)
        page.locator('#back-to-course').click()
        expect(page.locator('#course-overview')).to_be_visible()
        page.goto(BASE + '/academy.html?lesson=m1-l2', wait_until='domcontentloaded')
        expect(page.locator('.lesson-locked-notice')).to_contain_text('finish the earlier lesson')
        page.set_viewport_size({'width':390,'height':844})
        page.goto(BASE + '/academy.html', wait_until='domcontentloaded')
        assert_no_horizontal_overflow(page, 'academy mobile overview')
        page.screenshot(path=str(OUT / 'review-academy-mobile.png'), full_page=True)
        checks.append('Academy manifest for 18 modules/206 lessons, lazy-loaded lesson route, separated assessment CTA, and sequence lock')

        # Key chart types must render labelled diagrams, not generic or missing visuals.
        visual_ctx = browser.new_context(viewport={'width':1280,'height':900})
        stub_supabase(visual_ctx)
        visual = visual_ctx.new_page(); visual.on('pageerror', lambda error: page_errors.append(str(error)))
        module_counts = [9,8,9,13,10,10,12,12,13,14,13,14,13,12,11,11,11,11]
        all_ids = [f'm{module}-l{lesson}' for module, count in enumerate(module_counts, 1) for lesson in range(1, count + 1)]
        visual_targets = [
            ('m6-l3', 'candlestick chart schematic', ''), ('m7-l1', 'candlestick pattern schematic', ''),
            ('m8-l2', 'support and resistance chart', ''), ('m8-l4', 'trend and pullback', ''),
            ('m8-l6', 'supply and demand zones', 'SUPPLY'), ('m9-l9', 'swing structure', ''),
            ('m10-l6', 'liquidity sweep', ''), ('m10-l8', 'fair value gap', ''),
            ('m10-l9', 'order block', ''), ('m10-l14', 'take profit/exit and stop loss', 'STOP LOSS'),
        ]
        for lesson_id, accessible_label, chart_text in visual_targets:
            visual.goto(BASE + '/academy.html', wait_until='domcontentloaded')
            seeded_progress = {
                'version': 2, 'completed': [item for item in all_ids if item != lesson_id], 'bookmarks': [],
                'quizAttempts': 0, 'history': [], 'lastLessonId': lesson_id, 'updatedAt': '2026-11-26T00:00:00.000Z',
            }
            visual.evaluate("(progress) => localStorage.setItem('sifForexAcademyProgress.v2', JSON.stringify(progress))", seeded_progress)
            visual.goto(BASE + f'/academy.html?lesson={lesson_id}', wait_until='domcontentloaded')
            expect(visual.locator('.lesson-visual svg')).to_have_attribute('aria-label', re.compile(accessible_label, re.I))
            if chart_text:
                expect(visual.locator('.lesson-visual svg')).to_contain_text(chart_text)
        checks.append('labelled candle, pattern, support/resistance, trend, supply/demand, structure, liquidity, FVG, order-block, and entry/TP/SL schematics')

        # SIF Question: separate assessment hub, retries, answer explanations, pass gating, persistence, and mocked account sync.
        question_visual_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(question_visual_ctx)
        question_visual = question_visual_ctx.new_page(); question_visual.on('pageerror', lambda error: page_errors.append(str(error)))
        question_visual.goto(BASE + '/sif-question.html?lesson=m1-l1', wait_until='domcontentloaded')
        expect(question_visual.locator('#sif-question-form')).to_be_visible(timeout=10000)
        question_visual.screenshot(path=str(OUT / 'review-sif-question-desktop.png'), full_page=True)
        question_visual_ctx.close()
        question_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(question_ctx); set_test_user(question_ctx, 'review-question-user')
        question = question_ctx.new_page(); question.on('pageerror', lambda error: page_errors.append(str(error)))
        question.goto(BASE + '/sif-question.html?lesson=m1-l1', wait_until='domcontentloaded')
        expect(question.locator('#sif-question-form')).to_be_visible(timeout=10000)
        expect(question.locator('.quiz-question')).to_have_count(5)
        for fieldset in question.locator('.quiz-question').all():
            fieldset.locator('input[value="1"]').check()
        question.locator('.quiz-submit-btn').click()
        expect(question.locator('.quiz-feedback')).to_contain_text('0/5')
        expect(question.locator('.quiz-explanation.is-visible')).to_have_count(5)
        stored = question.evaluate("JSON.parse(localStorage.getItem('sifForexAcademyProgress.v2'))")
        assert stored['completed'] == [] and stored['quizAttempts'] == 1
        question.locator('[data-retry-quiz]').click()
        for fieldset in question.locator('.quiz-question').all():
            fieldset.locator('input[value="0"]').check()
        question.locator('.quiz-submit-btn').click()
        expect(question.locator('.quiz-feedback')).to_contain_text('5/5')
        expect(question.locator('[data-return-lesson]')).to_be_visible()
        question.wait_for_function("window.__reviewUpsert && window.__reviewUpsert.table === 'academy_progress' && window.__reviewUpsert.payload.progress.completed.includes('m1-l1')", timeout=10000)
        stored = question.evaluate("JSON.parse(localStorage.getItem('sifForexAcademyProgress.v2'))")
        assert stored['completed'] == ['m1-l1'] and stored['quizAttempts'] == 2
        question.locator('.sifq-back-link').click()
        expect(question.locator('a[href="sif-question.html?lesson=m1-l2"]')).to_be_visible()
        checks.append('SIF Question separate page, score failure/retry/pass, explanations, browser persistence, unlock, and review-only Supabase upsert mock')

        # Legacy four-lesson progress migrates to the new versioned course state without deleting the old key.
        migration_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        migration_ctx.add_init_script("localStorage.setItem('sifForexAcademyStartHere.v1', JSON.stringify({completed:['1','2']}));")
        migration = migration_ctx.new_page(); migration.on('pageerror', lambda error: page_errors.append(str(error)))
        migration.goto(BASE + '/sif-question.html', wait_until='domcontentloaded')
        expect(migration.locator('a[href="sif-question.html?lesson=m1-l3"]')).to_be_visible()
        migrated = migration.evaluate("JSON.parse(localStorage.getItem('sifForexAcademyProgress.v2'))")
        assert migrated['completed'] == ['m1-l1', 'm1-l2']
        assert migration.evaluate("localStorage.getItem('sifForexAcademyStartHere.v1')") is not None
        checks.append('legacy four-lesson progress migrates to v2 while preserving its original storage key')

        # Guided calculator handoff: only prefill values; no simulator trade is opened.
        page.set_viewport_size({'width':1440,'height':1000})
        page.goto(BASE + '/calculator.html?guided=1&balance=10000&risk=1&stopLoss=20&pipValue=10', wait_until='domcontentloaded')
        expect(page.locator('#guided-note')).to_be_visible()
        expect(page.locator('#balance')).to_have_value('10000')
        page.locator('#riskForm button[type="submit"]').click()
        expect(page.locator('#results')).to_be_visible()
        expect(page.locator('#lotSize')).to_contain_text('0.500')
        page.locator('#simulator-link').click()
        page.wait_for_url('**/simulator.html?guided=1*')
        expect(page.locator('#guidedExampleNotice')).to_be_visible()
        expect(page.locator('#direction')).to_have_value('')
        expect(page.locator('#openPositions tr')).to_have_count(1)
        expect(page.locator('#openPositions .empty')).to_be_visible()
        checks.append('calculator estimate and guided simulator prefill without auto-trading')

        # Simulator lifecycle in a fresh test context: open, mark-to-market, close, P/L, reset.
        sim_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        sim = sim_ctx.new_page()
        sim.on('pageerror', lambda error: page_errors.append(str(error)))
        sim.goto(BASE + '/simulator.html', wait_until='domcontentloaded')
        sim.locator('#marketPrice').fill('1.085')
        close_alert(sim); sim.locator('.update').click()
        sim.locator('#lots').fill('0.10')
        close_alert(sim); sim.locator('.buy').click()
        expect(sim.locator('#openPositions tr')).to_have_count(1)
        sim.locator('#marketPrice').fill('1.095')
        close_alert(sim); sim.locator('.update').click()
        sim.locator('#openPositions .close').click()
        expect(sim.locator('#history tr')).to_have_count(1)
        expect(sim.locator('#balance')).to_have_text('$10100.00')
        expect(sim.locator('#totalTrades')).to_have_text('1')
        close_alert(sim); sim.locator('.reset').click()
        expect(sim.locator('#balance')).to_have_text('$10000.00')
        expect(sim.locator('#history .empty')).to_be_visible()
        checks.append('simulator manual price, virtual BUY, P/L, close, history, reset')

        # Signed-out journal stays gated; signed-in journal saves and deletes locally by user ID.
        page.goto(BASE + '/journal.html', wait_until='domcontentloaded')
        expect(page.locator('#journalGateMessage')).to_contain_text('Sign in is required', timeout=10000)
        expect(page.locator('#journalApp')).to_be_hidden()
        user_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(user_ctx); set_test_user(user_ctx, 'review-journal-user')
        journal = user_ctx.new_page(); journal.on('pageerror', lambda error: page_errors.append(str(error)))
        journal.goto(BASE + '/journal.html', wait_until='domcontentloaded')
        expect(journal.locator('#journalApp')).to_be_visible(timeout=10000)
        journal.locator('#pair').fill('EURUSD')
        journal.locator('#entry').fill('1.085')
        journal.locator('#exit').fill('1.095')
        journal.locator('#result').fill('100')
        journal.locator('#notes').fill('Review-only smoke test')
        journal.locator('#tradeForm button[type="submit"]').click()
        expect(journal.locator('#totalTrades')).to_have_text('1')
        expect(journal.locator('#tradeHistory .trade')).to_have_count(1)
        stored = journal.evaluate("localStorage.getItem('sif_forex_journal_account_v2:review-journal-user')")
        assert stored and 'EURUSD' in stored
        close_alert(journal); journal.locator('.delete-btn').click()
        expect(journal.locator('#totalTrades')).to_have_text('0')
        checks.append('journal signed-out gate and signed-in local save/delete in isolated mock session')

        # Dashboard: mock authenticated Supabase profile, display real fields, and local-only progress.
        dash_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(dash_ctx); set_test_user(dash_ctx)
        dash_ctx.add_init_script("localStorage.setItem('sifForexAcademyProgress.v2', JSON.stringify({version:2,completed:['m1-l1','m1-l2'],bookmarks:[],quizAttempts:1,history:[],lastLessonId:'m1-l3',updatedAt:new Date().toISOString()}));")
        dash = dash_ctx.new_page(); dash.on('pageerror', lambda error: page_errors.append(str(error)))
        dash.goto(BASE + '/dashboard.html', wait_until='domcontentloaded')
        expect(dash.locator('#dashboardContent')).to_be_visible(timeout=10000)
        expect(dash.locator('#memberName')).to_have_text('Review Trader')
        expect(dash.locator('#memberUsername')).to_have_text('@review_user')
        expect(dash.locator('#memberEmail')).to_have_text('review@example.test')
        expect(dash.locator('#membership')).to_have_text('FREE MEMBER')
        expect(dash.locator('#learningProgress')).to_contain_text('2 of 206')
        expect(dash.locator('a.card[href="sif-question.html"]')).to_be_visible()
        expect(dash.locator('.card.is-unavailable')).to_have_count(3)
        close_alert(dash); dash.locator('#logoutButton').click()
        dash.wait_for_url('**/login.html', timeout=10000)
        guest_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(guest_ctx)
        guest_dash = guest_ctx.new_page(); guest_dash.on('pageerror', lambda error: page_errors.append(str(error)))
        guest_dash.goto(BASE + '/dashboard.html', wait_until='domcontentloaded')
        guest_dash.wait_for_url(re.compile(r'.*/login\.html(?:\?.*)?$'), timeout=10000)
        checks.append('dashboard guest redirect and auth/profile render, local progress, unavailable cards (mocked session only)')

        # Auth UI wiring is exercised only through the local Supabase stub; no real credentials/accounts used.
        auth_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(auth_ctx); set_test_user(auth_ctx, 'review-login-user')
        auth = auth_ctx.new_page(); auth.on('pageerror', lambda error: page_errors.append(str(error)))
        auth.goto(BASE + '/login.html', wait_until='domcontentloaded')
        auth.locator('#email').fill('review@example.test')
        auth.locator('#password').fill('review-password')
        auth.locator('#loginForm button[type="submit"]').click()
        expect(auth.locator('#message')).to_contain_text('Login successful', timeout=5000)
        auth.wait_for_url('**/dashboard.html', timeout=6000)
        auth.goto(BASE + '/register.html', wait_until='domcontentloaded')
        auth.locator('#fullName').fill('Review Trader')
        auth.locator('#username').fill('review_user')
        auth.locator('#email').fill('review@example.test')
        auth.locator('#password').fill('review-password')
        auth.locator('#confirmPassword').fill('review-password')
        auth.locator('#registerForm button[type="submit"]').click()
        expect(auth.locator('#message')).to_contain_text('Registration successful', timeout=5000)
        checks.append('login/signup form validation and success UI via review-only Supabase stub; no account created')

        # Mobile layout coverage (authenticated dashboard and each public page; fresh contexts preserve test data only).
        mobile_ctx = browser.new_context(viewport={'width':390,'height':844}, device_scale_factor=1)
        stub_supabase(mobile_ctx); set_test_user(mobile_ctx)
        mobile = mobile_ctx.new_page(); mobile.on('pageerror', lambda error: page_errors.append(str(error)))
        pages = ['index.html','academy.html','sif-question.html','calculator.html','charts.html','simulator.html','journal.html','login.html','register.html','dashboard.html']
        for route in pages:
            mobile.goto(BASE + '/' + route, wait_until='domcontentloaded')
            if route == 'dashboard.html':
                expect(mobile.locator('#dashboardContent')).to_be_visible(timeout=10000)
            if route == 'index.html':
                expect(mobile.locator('#nav-login')).to_have_text('Dashboard')
                expect(mobile.locator('#nav-register')).to_be_hidden()
            if route == 'journal.html':
                expect(mobile.locator('#journalApp')).to_be_visible(timeout=10000)
            assert_no_horizontal_overflow(mobile, route)
            toggle = mobile.locator('.menu-toggle')
            if await_visible(toggle):
                toggle.click()
                expect(mobile.locator('#navigation')).to_have_class(re.compile('active'))
                toggle.click()
                expect(mobile.locator('#navigation')).not_to_have_class(re.compile('active'))
        # Capture a clean mobile homepage screenshot for owner review.
        mobile.goto(BASE + '/index.html', wait_until='domcontentloaded')
        expect(mobile.frame_locator('.dashboard-chart iframe').locator('body')).to_contain_text('Indicative data', timeout=20000)
        mobile.screenshot(path=str(OUT / 'review-homepage-mobile.png'), full_page=True)
        mobile.goto(BASE + '/sif-question.html?lesson=m1-l1', wait_until='domcontentloaded')
        expect(mobile.locator('#sif-question-form')).to_be_visible(timeout=10000)
        assert_no_horizontal_overflow(mobile, 'SIF Question mobile assessment')
        question_mobile_ctx = browser.new_context(viewport={'width':390,'height':844}, device_scale_factor=1)
        stub_supabase(question_mobile_ctx)
        question_mobile = question_mobile_ctx.new_page(); question_mobile.on('pageerror', lambda error: page_errors.append(str(error)))
        question_mobile.goto(BASE + '/sif-question.html?lesson=m1-l1', wait_until='domcontentloaded')
        expect(question_mobile.locator('#sif-question-form')).to_be_visible(timeout=10000)
        assert_no_horizontal_overflow(question_mobile, 'SIF Question mobile screenshot')
        question_mobile.screenshot(path=str(OUT / 'review-sif-question-mobile.png'), full_page=True)
        question_mobile_ctx.close()
        checks.append('mobile viewport (390px) for all pages including separate assessment, menu open/close, no horizontal overflow')

        # No uncaught application JavaScript exceptions in exercised pages.
        if page_errors:
            raise AssertionError('Uncaught page errors: ' + ' | '.join(page_errors))
        print('PASS:')
        for check in checks: print(' - ' + check)
        print('All browser regression checks passed. Review Auth flows used a local mock; no live account or credential was used.')
        print('Screenshots:', OUT / 'review-homepage-desktop.png', OUT / 'review-homepage-mobile.png', OUT / 'review-academy-desktop.png', OUT / 'review-academy-lesson.png', OUT / 'review-academy-mobile.png', OUT / 'review-sif-question-desktop.png', OUT / 'review-sif-question-mobile.png')
        browser.close()


def await_visible(locator):
    try:
        return locator.count() > 0 and locator.is_visible()
    except Exception:
        return False


if __name__ == '__main__':
    main()
