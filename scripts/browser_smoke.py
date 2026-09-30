"""Run against the synthetic demo server, not a changing real detector feed."""
import argparse
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser()
p.add_argument("--url", default="http://127.0.0.1:8000/")
p.add_argument("--chromium", help="Optional local Chromium executable")
a = p.parse_args()
with sync_playwright() as tools:
    browser = tools.chromium.launch(headless=True, executable_path=a.chromium,
        args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(a.url, wait_until="networkidle")
    page.wait_for_function("document.querySelector('#plot3d').dataset.eventIndex !== undefined")
    assert page.locator("#feed-state").inner_text() == "DEMO", "Use a demo cache"
    assert "WebGL is not supported" not in page.locator("#plot3d").inner_text()
    page.click("#playback")
    first = page.locator("#event-title").inner_text()
    eye = page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye")
    page.wait_for_timeout(700)
    assert eye != page.evaluate("document.querySelector('#plot3d').layout.scene.camera.eye")
    page.wait_for_timeout(3500)
    assert first == page.locator("#event-title").inner_text()
    page.click("#next")
    page.wait_for_timeout(700)
    assert first != page.locator("#event-title").inner_text()
    assert page.evaluate("new Set(document.querySelector('#plot3d').data[0].marker.color).size") > 1
    assert not errors, errors
    browser.close()
    print("Browser smoke: WebGL, camera, colors, pause and next passed")
