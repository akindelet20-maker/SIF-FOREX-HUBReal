from pathlib import Path
import struct
import zlib
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:4173'


def png_bytes():
    width, height = 96, 64
    row = b'\x00' + bytes([7, 20, 38]) * width
    raw = row * height

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


ANALYSIS_FIXTURE = {
    'pair': 'EUR/USD', 'timeframe': '1h', 'summary': 'Test-only UI fixture; not a real chart reading.',
    'observedBias': 'unclear', 'overallConfidence': 'low',
    'marketStructure': {'reading': 'Test fixture only.', 'evidence': 'No live analysis in this test.', 'confidence': 'low'},
    'liquidity': {'reading': 'Test fixture only.', 'evidence': 'No live analysis in this test.', 'confidence': 'low'},
    'bos': {'status': 'not-clear', 'explanation': 'Test fixture only.'},
    'choch': {'status': 'not-clear', 'explanation': 'Test fixture only.'},
    'fairValueGap': {'status': 'not-clear', 'explanation': 'Test fixture only.'},
    'bullishScenario': {'conditionsToWatch': 'Test fixture only.', 'whatWouldWeaken': 'Test fixture only.'},
    'bearishScenario': {'conditionsToWatch': 'Test fixture only.', 'whatWouldWeaken': 'Test fixture only.'},
    'annotations': [{'concept': 'fvg', 'label': 'Test marker', 'explanation': 'Test fixture only.', 'x': .4, 'y': .6}],
    'caveats': ['Test fixture only.']
}


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.route('**/api/chart-coach', lambda route: route.fulfill(status=200, content_type='application/json', json=ANALYSIS_FIXTURE))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE + '/charts.html#ai-coach', wait_until='domcontentloaded')
        expect(page.locator('#coach-title')).to_have_text('SIF AI Chart Coach')
        expect(page.locator('#analyze-button')).to_be_disabled()
        expect(page.locator('#coach-form')).to_be_visible()
        # The form is available to guests; the mobile sign-in link remains in the collapsed menu.
        expect(page.locator('#navigation')).not_to_have_class('active')

        image = png_bytes()
        page.locator('#chart-file').set_input_files({
            'name': 'test-chart.png', 'mimeType': 'image/png', 'buffer': image
        })
        expect(page.locator('#preview-section')).to_be_visible()
        expect(page.locator('#analyze-button')).to_be_enabled()
        page.locator('#currency-pair').select_option('GBP/USD')
        page.locator('#chart-timeframe').select_option('4h')
        page.locator('#analyze-button').click()
        expect(page.locator('#analysis-results')).to_be_visible(timeout=10000)
        expect(page.locator('#pair-timeframe-tag')).to_have_text('GBP/USD · 4h')
        expect(page.locator('#analysis-summary-text')).to_contain_text('Test-only UI fixture')
        expect(page.locator('#annotation-layer .annotation-marker')).to_have_count(1)
        expect(page.locator('#annotation-list')).to_contain_text('Test marker')
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        assert not errors, 'Uncaught browser errors: ' + ' | '.join(errors)

        page.locator('#clear-chart').click()
        expect(page.locator('#analysis-results')).to_be_hidden()
        expect(page.locator('#preview-section')).to_be_hidden()
        expect(page.locator('#analyze-button')).to_be_disabled()
        browser.close()
    print('PASS: public Coach upload form, selection controls, preview, API response rendering, annotations, mobile width and clear action (test-only API fixture).')


if __name__ == '__main__':
    main()
