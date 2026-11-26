from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:4173'
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
    from: () => {
      const query = { select() { return query; }, eq() { return query; }, maybeSingle: async () => ({ data: profile, error: null }) };
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

        # Academy: all quick checks, local progress, quiz, score-sharing and challenge route.
        page.goto(BASE + '/academy.html', wait_until='domcontentloaded')
        lesson_answers = {1: 'a', 2: 'a', 3: 'b', 4: 'a'}
        for lesson, answer in lesson_answers.items():
            page.locator(f'input[name="check-{lesson}"][value="{answer}"]').check()
            page.locator(f'button[data-check="{lesson}"]').click()
            expect(page.locator(f'#lesson-{lesson} .check-feedback')).not_to_be_empty()
            if lesson < 4:
                page.locator(f'.continue-button[data-next="{lesson + 1}"]').click()
            else:
                page.locator('.continue-button[data-next="quiz"]').click()
        expect(page.locator('#progress-label')).to_contain_text('4 of 4')
        quiz_answers = {'q1':'b', 'q2':'a', 'q3':'a', 'q4':'b', 'q5':'b'}
        for name, value in quiz_answers.items():
            page.locator(f'input[name="{name}"][value="{value}"]').check()
        page.locator('#quiz-form button[type="submit"]').click()
        expect(page.locator('#quiz-share-card')).to_be_visible()
        expect(page.locator('#share-score')).to_have_text('5')
        page.locator('#copy-challenge-link').click()
        expect(page.locator('#challenge-link')).to_have_value(f'{BASE}/academy.html?challenge=5')
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('#progress-label')).to_contain_text('4 of 4')
        page.locator('#reset-progress').click()
        expect(page.locator('#progress-label')).to_contain_text('0 of 4')
        page.goto(BASE + '/academy.html?challenge=3', wait_until='domcontentloaded')
        expect(page.locator('#incoming-challenge')).to_be_visible()
        page.screenshot(path=str(OUT / 'review-academy-mobile.png'), full_page=True) if page.set_viewport_size({'width':390,'height':844}) is None else None
        checks.append('Academy checks, progress persistence/reset, quiz, share link, challenge route')

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
        dash_ctx.add_init_script("localStorage.setItem('sifForexAcademyStartHere.v1', JSON.stringify({completed:['1','2']}));")
        dash = dash_ctx.new_page(); dash.on('pageerror', lambda error: page_errors.append(str(error)))
        dash.goto(BASE + '/dashboard.html', wait_until='domcontentloaded')
        expect(dash.locator('#dashboardContent')).to_be_visible(timeout=10000)
        expect(dash.locator('#memberName')).to_have_text('Review Trader')
        expect(dash.locator('#memberUsername')).to_have_text('@review_user')
        expect(dash.locator('#memberEmail')).to_have_text('review@example.test')
        expect(dash.locator('#membership')).to_have_text('FREE MEMBER')
        expect(dash.locator('#learningProgress')).to_contain_text('2 of 4')
        expect(dash.locator('.card.is-unavailable')).to_have_count(3)
        close_alert(dash); dash.locator('#logoutButton').click()
        dash.wait_for_url('**/login.html', timeout=10000)
        guest_ctx = browser.new_context(viewport={'width':1440,'height':1000})
        stub_supabase(guest_ctx)
        guest_dash = guest_ctx.new_page(); guest_dash.on('pageerror', lambda error: page_errors.append(str(error)))
        guest_dash.goto(BASE + '/dashboard.html', wait_until='domcontentloaded')
        guest_dash.wait_for_url('**/login.html', timeout=10000)
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
        pages = ['index.html','academy.html','calculator.html','charts.html','simulator.html','journal.html','login.html','register.html','dashboard.html']
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
        checks.append('mobile viewport (390px) for all pages, navigation open/close, no horizontal overflow')

        # No uncaught application JavaScript exceptions in exercised pages.
        if page_errors:
            raise AssertionError('Uncaught page errors: ' + ' | '.join(page_errors))
        print('PASS:')
        for check in checks: print(' - ' + check)
        print('All browser regression checks passed. Review Auth flows used a local mock; no live account or credential was used.')
        print('Screenshots:', OUT / 'review-homepage-desktop.png', OUT / 'review-homepage-mobile.png')
        browser.close()


def await_visible(locator):
    try:
        return locator.count() > 0 and locator.is_visible()
    except Exception:
        return False


if __name__ == '__main__':
    main()
