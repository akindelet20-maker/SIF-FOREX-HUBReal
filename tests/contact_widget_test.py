from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGES = [
    'index.html', 'academy.html', 'sif-question.html', 'calculator.html',
    'charts.html', 'journal.html', 'login.html', 'register.html', 'dashboard.html',
]
INTRO = 'Hello SIF FOREX HUB, I visited your website and would like to make an enquiry. Please assist me.'
WHATSAPP = 'https://wa.me/2349063261262?text=Hello%20SIF%20FOREX%20HUB%2C%20I%20visited%20your%20website%20and%20would%20like%20to%20make%20an%20enquiry.%20Please%20assist%20me.'
SOCIAL = {
    'WhatsApp': WHATSAPP,
    'TikTok': 'https://tiktok.com/@sifforexhub_001',
    'Instagram': 'https://www.instagram.com/sifforexhub001',
    'Telegram': 'https://t.me/SifForexHub001',
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def start_server():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


def verify_external_links(context, page, locator, expected):
    for label, url in expected.items():
        link = locator.filter(has_text=label).first
        if not link.is_visible():
            page.locator('.sif-contact-launcher').click()
            link = locator.filter(has_text=label).first
        expect(link).to_be_visible()
        assert link.get_attribute('href') == url, f'{label} href mismatch: {link.get_attribute("href")}'
        assert link.get_attribute('target') == '_blank', f'{label} should open a new tab'
        rel = set((link.get_attribute('rel') or '').split())
        assert {'noopener', 'noreferrer'} <= rel, f'{label} is missing safe external-link rel values'
        with page.expect_popup() as popup_info:
            link.click()
        popup = popup_info.value
        popup.wait_for_load_state('domcontentloaded')
        assert popup.url == url, f'{label} opened {popup.url}, expected {url}'
        popup.close()


def main():
    server, base = start_server()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
            context = browser.new_context(viewport={'width': 1440, 'height': 950})
            for pattern in ['https://wa.me/**', 'https://tiktok.com/**', 'https://www.instagram.com/**', 'https://t.me/**']:
                context.route(pattern, lambda route: route.fulfill(status=200, content_type='text/html', body='Link target intercepted for test.'))
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            for route in PAGES:
                page.goto(f'{base}/{route}', wait_until='domcontentloaded')
                launcher = page.locator('.sif-contact-launcher')
                menu = page.locator('#sif-contact-menu')
                expect(launcher).to_be_visible()
                expect(menu).to_be_hidden()
                launcher.click()
                expect(menu).to_be_visible()
                expect(launcher).to_have_attribute('aria-expanded', 'true')
                assert menu.locator('.sif-contact-option').count() == 3
                assert [menu.locator('.sif-contact-option').nth(i).inner_text().splitlines()[0].strip() for i in range(3)] == ['WhatsApp', 'TikTok', 'Instagram']
                menu_links = {name: url for name, url in list(SOCIAL.items())[:3]}
                for name, url in menu_links.items():
                    link = menu.locator('.sif-contact-option').filter(has_text=name).first
                    assert link.get_attribute('href') == url, f'{route}: {name} destination mismatch'
                    assert link.get_attribute('target') == '_blank'
                    assert {'noopener', 'noreferrer'} <= set((link.get_attribute('rel') or '').split())
                page.keyboard.press('Escape')
                expect(menu).to_be_hidden()
                expect(launcher).to_have_attribute('aria-expanded', 'false')
                width = page.evaluate('document.documentElement.scrollWidth')
                viewport = page.evaluate('window.innerWidth')
                assert width <= viewport + 1, f'{route}: horizontal overflow {width}px > {viewport}px'

            page.goto(f'{base}/index.html', wait_until='domcontentloaded')
            expect(page.get_by_role('heading', name="LET'S CONNECT WITH SIF FOREX HUB")).to_be_visible()
            expect(page.get_by_text(INTRO, exact=False)).to_have_count(0)
            expect(page.locator('.contact-panel > p')).to_contain_text('Have questions about Forex education, our trading tools, subscriptions, or membership?')
            verify_external_links(context, page, page.locator('.contact-link'), SOCIAL)

            # Exercise each live menu link in a test-only intercepted popup; no message or social action is sent.
            page.locator('.sif-contact-launcher').click()
            verify_external_links(context, page, page.locator('.sif-contact-option'), {name: url for name, url in list(SOCIAL.items())[:3]})

            page.set_viewport_size({'width': 390, 'height': 844})
            for route in PAGES:
                page.goto(f'{base}/{route}', wait_until='domcontentloaded')
                launcher = page.locator('.sif-contact-launcher')
                expect(launcher).to_be_visible()
                box = launcher.bounding_box()
                assert box and box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= 390 and box['y'] + box['height'] <= 844, f'{route}: floating button outside mobile viewport'
                launcher.click()
                expect(page.locator('#sif-contact-menu')).to_be_visible()
                menu_box = page.locator('#sif-contact-menu').bounding_box()
                assert menu_box and menu_box['x'] >= 0 and menu_box['x'] + menu_box['width'] <= 390, f'{route}: contact menu outside mobile viewport'
                page.keyboard.press('Escape')
                assert page.evaluate('document.documentElement.scrollWidth') <= 391, f'{route}: mobile horizontal overflow'

            if errors:
                raise AssertionError('Uncaught browser errors: ' + ' | '.join(errors))
            print('PASS: floating contact control appears and opens/closes on all 9 key pages.')
            print('PASS: WhatsApp intro text, all 4 official destinations, new-tab handling, and safe rel attributes are correct.')
            print('PASS: each contact button opens the intended test-intercepted link; no message, follow, or group action is sent.')
            print('PASS: Escape behavior, mobile bounds, and no horizontal overflow at 390px.')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
