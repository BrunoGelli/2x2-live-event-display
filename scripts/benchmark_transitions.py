"""Benchmark real Plotly WebGL event updates, without FLOW I/O or network waits.

Run against a dedicated demo server. Results from software-rendered CI are
comparative diagnostics, not a promise of performance on a shifter's GPU.
"""
import argparse
import json
import time

from playwright.sync_api import sync_playwright


BENCHMARK = r"""async ({points, repeats}) => {
  const gd = document.querySelector('#plot3d');
  const clone = value => JSON.parse(JSON.stringify(value));
  const geometry = clone(gd.data.slice(1));
  const initial = clone(gd.layout);
  initial.annotations = [];
  const template = clone(gd.data[0]);
  const options = {responsive: true, displaylogo: false, scrollZoom: true};
  function event(k) {
    const x=[], y=[], z=[], q=[], colors=[];
    for (let i=0;i<points;i++) {
      x.push(-58+116*((i*719+k*13)%points)/points);
      y.push(-56+112*((i*313+k*23)%points)/points);
      z.push(-54+108*((i*199+k*43)%points)/points);
      const c=((i*67+k*7)%points)/points*3;
      colors.push(c);q.push(Math.pow(10,c));
    }
    return {...template,x,y,z,customdata:q,
      marker:{...template.marker,color:colors,cmin:0,cmax:3,cauto:false}};
  }
  const methods = ['full-react','stable-react','restyle'];
  const measurements = [];
  for (const method of methods) {
    await Plotly.react(gd,[event(0),...clone(geometry)],clone(initial),options);
    await new Promise(r=>setTimeout(r,150));
    for (let k=0;k<repeats+1;k++) {
      const data = event(k+1);
      let frameId=null,last=performance.now(),largest=0;
      const tick = now => {largest=Math.max(largest,now-last);last=now;frameId=requestAnimationFrame(tick);};
      frameId=requestAnimationFrame(tick);
      await new Promise(r=>requestAnimationFrame(r));
      const start=performance.now();
      if (method==='full-react') {
        await Plotly.react(gd,[data,...clone(geometry)],clone(initial),options);
      } else if (method==='stable-react') {
        await Plotly.react(gd,[data,...gd.data.slice(1)],gd.layout,options);
      } else {
        await Plotly.restyle(gd,{x:[data.x],y:[data.y],z:[data.z],customdata:[data.customdata],
          'marker.color':[data.marker.color],'marker.cmin':0,'marker.cmax':3,'marker.cauto':false},[0]);
      }
      const updateMs=performance.now()-start;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      cancelAnimationFrame(frameId);
      if (k) measurements.push({method,points,update_ms:updateMs,max_frame_gap_ms:largest});
    }
  }
  return {plotly:Plotly.version,user_agent:navigator.userAgent,measurements};
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8000/')
    parser.add_argument('--points', type=int, default=20000)
    parser.add_argument('--repeats', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.points <= 100000 or not 1 <= args.repeats <= 20:
        parser.error('points must be 1..100000; repeats 1..20')
    with sync_playwright() as tools:
        browser = tools.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        try:
            page = browser.new_page(viewport={'width':1440,'height':1000})
            page.goto(args.url, wait_until='networkidle')
            deadline = time.monotonic()+30
            while not page.evaluate("document.querySelector('#plot3d').dataset.eventIndex !== undefined"):
                if time.monotonic()>deadline:
                    raise RuntimeError('Demo viewer did not load')
                page.wait_for_timeout(100)
            assert page.locator('#feed-state').inner_text()=='DEMO', 'Use a dedicated DEMO server'
            page.click('#playback')
            page.uncheck('#rotate')
            page.wait_for_timeout(200)
            assert 'WebGL is not supported' not in page.locator('#plot3d').inner_text()
            assert page.evaluate("Array.from(document.querySelector('#plot3d').querySelectorAll('canvas')).some(c=>!!(c.getContext('webgl')||c.getContext('webgl2')))")
            result = page.evaluate(BENCHMARK, {'points':args.points,'repeats':args.repeats})
            print('TRANSITION_BENCHMARK='+json.dumps(result), flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
