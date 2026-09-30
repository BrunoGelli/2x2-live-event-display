"""Real HTTP/CSP/WebGL smoke test. Use only a dedicated synthetic demo cache."""
import argparse
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def wait_until(page, expression, *, arg=None, timeout=30000):
    """Poll via the automation protocol, not wait_for_function's in-page eval.

    In some Playwright versions wait_for_function builds predicates with eval(),
    which violates this app's CSP before the actual viewer can be tested.
    This helper leaves the page CSP intact; it only observes its state.
    """
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        if page.evaluate(expression, arg):
            return
        page.wait_for_timeout(50)
    raise AssertionError(f"Browser condition timed out: {expression}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8000/')
    parser.add_argument('--chromium', help='Optional local Chromium executable')
    parser.add_argument('--cache', type=Path, help='Dedicated demo cache, enables generation rollover test')
    args = parser.parse_args()
    with sync_playwright() as tools:
        browser = tools.chromium.launch(headless=True, executable_path=args.chromium,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('''window.cspViolations=[];
          document.addEventListener('securitypolicyviolation',e=>
            window.cspViolations.push(e.violatedDirective+': '+e.blockedURI));''')
        try:
            response = page.goto(args.url, wait_until='networkidle')
            assert response and "script-src 'self'" in response.headers.get('content-security-policy','')
            assert 'unsafe-eval' not in response.headers['content-security-policy']
            wait_until(page, "document.querySelector('#plot3d').dataset.eventIndex !== undefined")
            assert page.locator('#feed-state').inner_text() == 'DEMO', 'Use a demo cache'
            assert 'WebGL is not supported' not in page.locator('#plot3d').inner_text()
            page.click('#playback')
            first = page.locator('#event-title').inner_text()
            eye = page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye")
            page.wait_for_timeout(800)
            assert eye != page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye")
            page.wait_for_timeout(3200)
            assert first == page.locator('#event-title').inner_text(), 'Pause cycling changed the event'
            catalog = page.request.get(args.url.rstrip('/')+'/api/catalog').json()
            assert catalog['sampled_events'] >= 3, 'Use at least 3 synthetic events'

            # The forward neighbor is prefetched. The previous/last event is not.
            target = catalog['events'][-1]['event_index']
            routes = []
            route_pattern = f'**/api/generations/{catalog["generation"]}/events/{target}'
            page.route(route_pattern, lambda route: routes.append(route))
            page.click('#previous')
            page.wait_for_timeout(250)
            assert routes, 'Expected uncached request to hold'
            eye = page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye")
            page.wait_for_timeout(800)
            assert first == page.locator('#event-title').inner_text()
            assert eye != page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye"), \
                'Camera froze while event fetch waited'
            routes[0].continue_()
            wait_until(page, "i => document.querySelector('#plot3d').dataset.eventIndex === String(i)", arg=target)
            page.unroute(route_pattern)
            assert page.evaluate("new Set(document.querySelector('#plot3d').data[0].marker.color).size") > 1

            page.locator('#projection-details summary').click()
            wait_until(page, '''() => {
              const p=document.querySelector('#plot2d');
              return p.style.visibility === 'visible' && p.data && p.data.length === 3;
            }''')
            assert page.evaluate("document.querySelector('#plot2d').data.every(t=>t.type==='scattergl')")
            assert 'WebGL is not supported' not in page.locator('#plot2d').inner_text()
            assert page.evaluate('window.cspViolations') == [], page.evaluate('window.cspViolations')
            # Rendering under real WebGL, not merely changed camera JSON.
            for selector in ('#plot3d', '#plot2d'):
                assert page.evaluate('''selector => Array.from(document.querySelector(selector).querySelectorAll('canvas'))
                    .some(c => !!(c.getContext('webgl') || c.getContext('webgl2')))''', selector), selector
            page.click('#next')
            wait_until(page, "document.querySelector('#plot3d').dataset.eventIndex === '0'")
            wait_until(page, "document.querySelector('#plot2d').dataset.eventIndex === '0'")

            if args.cache:
                from live2x2.cache import latest, writer_lock
                from live2x2.demo import generate
                assert latest(args.cache).get('demo'), 'Refusing to modify a non-demo cache'
                with writer_lock(args.cache):
                    newer = generate(args.cache, catalog['sampled_events'])
                wait_until(page, "!document.querySelector('#latest').hidden", timeout=25000)
                assert page.locator('#plot3d').get_attribute('data-generation') == catalog['generation'], \
                    'Paused viewer switched generations without consent'
                page.click('#latest')
                wait_until(page, "g => document.querySelector('#plot3d').dataset.generation === g",
                    arg=newer['generation'])
                wait_until(page, "g => document.querySelector('#plot2d').dataset.generation === g",
                    arg=newer['generation'])
            assert not errors, errors
        finally:
            browser.close()
    print('Browser smoke passed: delayed fetch rotation, WebGL 3D/projections, CSP, Q colors, pause/navigation' +
          (' and generation rollover' if args.cache else ''))


if __name__ == '__main__':
    main()
