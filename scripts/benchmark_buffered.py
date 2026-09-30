"""Exercise ready-buffer handovers using synthetic dense events and actual WebGL.

Uses a dedicated DEMO server. Network interception changes only this test browser's
payloads, not the server cache. Measurements are diagnostics, not fixed FPS promises.
"""
import argparse
import json
import math

from playwright.sync_api import sync_playwright
from browser_smoke import wait_until


def dense_event(index, points):
    x=[-58+116*((i*719+index*13)%points)/points for i in range(points)]
    y=[-56+112*((i*313+index*23)%points)/points for i in range(points)]
    z=[-54+108*((i*199+index*43)%points)/points for i in range(points)]
    colors=[((i*67+index*7)%points)/points*3 for i in range(points)]
    q=[10**c for c in colors]
    return dict(event_index=index,event_id=str(1000+index),hits=dict(x=x,y=y,z=z,Q=q),
        color=dict(values=colors,minimum=0,maximum=3,label='synthetic log10(Q)'),
        summary=dict(raw_hits=points,renderable_hits=points,plotted_hits=points,
            finite_Q_sum=sum(q),omitted_nonfinite=0,outside_nominal=0,sampled_hits=False))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',default='http://127.0.0.1:8000/')
    p.add_argument('--points',type=int,default=20000)
    p.add_argument('--transitions',type=int,default=6)
    a=p.parse_args()
    if not 1 <= a.points <= 100000 or not 1 <= a.transitions <= 60:
        p.error('points 1..100000 and transitions 1..60 required')
    with sync_playwright() as tools:
        browser=tools.chromium.launch(headless=True,
            args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        try:
            page=browser.new_page(viewport={'width':1440,'height':1000})
            catalog=page.request.get(a.url.rstrip('/')+'/api/catalog').json()
            assert catalog.get('demo') and len(catalog['events'])>=3, 'Use a dedicated DEMO cache with >=3 events'
            payloads={r['event_index']:json.dumps(dense_event(r['event_index'],a.points)) for r in catalog['events']}
            def intercept(route):
                index=int(route.request.url.rstrip('/').split('/')[-1])
                route.fulfill(status=200,content_type='application/json',body=payloads[index])
            page.route('**/api/generations/*/events/*',intercept)
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(a.url,wait_until='networkidle')
            wait_until(page,"document.querySelector('#plot3d').dataset.eventIndex !== undefined")
            assert page.locator('.scene-buffer').count()==2
            page.click('#playback')
            # Keep rotation enabled: promotion must synchronize to the moving
            # foreground camera, not take the easier unchanged-camera path.
            assert page.locator('#rotate').is_checked()
            page.evaluate('''() => {
                window.foregroundRedraws=0;
                const original=Plotly.react;
                Plotly.react=function(node,...args){
                    const gd=typeof node==='string'?document.getElementById(node):node;
                    if(gd.id==='plot3d')window.foregroundRedraws++;
                    return original.call(this,node,...args);
                };
            }''')
            results=[]
            for _ in range(a.transitions):
                index=int(page.locator('#plot3d').get_attribute('data-event-index'))
                position=next(i for i,r in enumerate(catalog['events']) if r['event_index']==index)
                target=catalog['events'][(position+1)%len(catalog['events'])]['event_index']
                key=f"{catalog['generation']}/{target}"
                wait_until(page,"key => {const p=document.querySelector('#plot3d-buffer');return p.dataset.preparedReady==='true' && p.dataset.preparedKey===key;}",arg=key)
                page.click('#next')
                wait_until(page,"i => document.querySelector('#plot3d').dataset.eventIndex===String(i)",arg=target)
                data=page.evaluate('''() => {
                    const p=document.querySelector('#plot3d');
                    return {handover_ms:Number(p.dataset.renderMs),prepare_ms:Number(p.dataset.prepareMs),
                        prepared:p.dataset.preRendered,points:p.data[0].x.length,
                        visible:getComputedStyle(p).opacity,
                        hidden:getComputedStyle(document.querySelector('#plot3d-buffer')).opacity,
                        colors:new Set(p.data[0].marker.color).size};
                }''')
                assert data['prepared']=='true' and data['points']==a.points
                assert data['visible']=='1' and data['hidden']=='0' and data['colors']>1
                assert math.isfinite(data['handover_ms']) and math.isfinite(data['prepare_ms'])
                results.append(data)
            assert page.evaluate('window.foregroundRedraws')==0
            assert not errors,errors
            assert page.locator('#rotate').is_checked()
            assert 'WebGL is not supported' not in page.locator('#plot3d').inner_text()
            assert page.evaluate("Array.from(document.querySelector('#plot3d').querySelectorAll('canvas')).some(c=>!!(c.getContext('webgl')||c.getContext('webgl2')))")
            print('BUFFERED_BENCHMARK='+json.dumps(dict(points=a.points,rotation=True,transitions=results)),flush=True)
        finally:
            browser.close()


if __name__=='__main__':
    main()
