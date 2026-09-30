"""No network in unit tests; browser CI checks the real upstream bundle."""
import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from live2x2 import cli, web
from live2x2.cache import writer_lock
from live2x2.demo import generate


def test_asset_install_validates_full_content_and_is_atomic(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'STATIC', tmp_path/'static')
    data=b'/* test strict bundle */\n'+b'x'*100001
    blob=hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
    monkeypatch.setattr(cli,'PLOTLY_STRICT_BLOB',blob)
    source=tmp_path/'from-file.js';source.write_bytes(data)
    cli.install_assets(source)
    dest=web.STATIC/web.PLOTLY_ASSET
    assert dest.read_bytes()==data
    source.write_bytes(data[:-1])
    with pytest.raises(ValueError,match='STRICT'):
        cli.install_assets(source)
    assert dest.read_bytes()==data  # Failed download never damages the installed asset.


def test_page_and_readiness_use_strict_asset_without_weakening_csp(tmp_path,monkeypatch):
    with writer_lock(tmp_path/'cache'):
        generate(tmp_path/'cache',2)
    root=tmp_path/'static';(root/'vendor').mkdir(parents=True)
    (root/'index.html').write_text((web.STATIC/'index.html').read_text())
    monkeypatch.setattr(web,'STATIC',root)
    client=TestClient(web.create_app(tmp_path/'cache'))
    assert client.get('/readyz').status_code==503
    (root/'vendor/plotly.min.js').write_text('old bundle')
    assert client.get('/readyz').status_code==503
    (root/web.PLOTLY_ASSET).write_text('test strict bundle')
    assert client.get('/readyz').status_code==200
    response=client.get('/')
    assert 'static/vendor/plotly-strict.min.js' in response.text
    assert "script-src 'self'" in response.headers['content-security-policy']
    assert 'unsafe-eval' not in response.headers['content-security-policy']
