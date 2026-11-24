// スマホとつなぐ QR（plugins/mobile/src/bind-link.mjs）と、アプリが読む側（apps/mobile/src/notify/bind-link.ts）。
// QR は別の読み取りの部品（jsqr）で SVG の絵から読み戻し、中身が aioffice://bind?code=… になっているかを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { bindLinkOf, qrSvgOf, qrDataUrlOf } from '../plugins/mobile/src/bind-link.mjs';
import { parseBindLink } from '../apps/mobile/src/notify/bind-link.ts';

// SVG の path（M x y h c v c h -c z の並び）を RGBA の画素に描く
function pixelsOf(svg) {
  const size = Number(/width="(\d+)"/.exec(svg)[1]);
  const cell = Number(/h(\d+)v/.exec(svg)[1]);
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const m of svg.matchAll(/M(\d+) (\d+)h/g)) {
    const x0 = Number(m[1]); const y0 = Number(m[2]);
    for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) { const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  }
  return { data, size };
}

test('QR を読み戻すと aioffice://bind?code=<code> になり、アプリの読み方で同じ code が取れる', () => {
  for (const code of ['ABCD-EFGH-JKLM', 'abcd2345wxyz', 'A1B2']) {
    const link = bindLinkOf(code);
    const { data, size } = pixelsOf(qrSvgOf(link));
    const r = jsQR(data, size, size);
    assert.ok(r, `読めない: ${code}`);
    assert.equal(r.data, link);
    assert.equal(parseBindLink(r.data), code.toUpperCase());
  }
});

test('bindLinkOf は形の違う code を断る（URL に余計な物を入れない）', () => {
  for (const bad of ['', 'AB', 'ABCD&x=1', 'ABCD EFGH', 'ABCD/EFGH', '<script>']) assert.throws(() => bindLinkOf(bad), /形が違う/, bad);
});

test('qrDataUrlOf は img に入れる data URL', () => {
  assert.match(qrDataUrlOf(bindLinkOf('ABCD-EFGH')), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
});

test('parseBindLink: bind 以外（サインインの戻り）や形の違う code は null', () => {
  assert.equal(parseBindLink('aioffice://bind?code=abcd-efgh'), 'ABCD-EFGH');
  assert.equal(parseBindLink('aioffice://bind/?x=1&code=ABCD1234'), 'ABCD1234');
  for (const u of [null, '', 'aioffice://auth?code=ABCD1234', 'https://example.com/bind?code=ABCD1234', 'aioffice://bind?code=AB', 'aioffice://bind?code=%E0%A4%A', 'aioffice://bind?code=ABCD%26x', 'aioffice://bind']) {
    assert.equal(parseBindLink(u), null, String(u));
  }
});
