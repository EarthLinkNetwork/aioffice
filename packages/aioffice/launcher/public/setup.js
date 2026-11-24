// AI オフィスの wizard（日英）。言語 → 持ち主の合言葉 → 会社の名前 → 使う AI を選んでつなぐ → 秘書 → ほかの担当（担当ごとに AI を選ぶ）→ 手元の文書 → 完了
// 文字は全部 /setup/api/i18n の辞書から出す（画面に直に文言を書かない）
(() => {
  const app = document.getElementById('app');
  let D = null, S = null, step = null, poll = null;
  const t = k => (D?.[S?.lang || 'en']?.[k]) ?? k;
  // ブラウザの時刻帯（朝夕のまとめの時刻に使う）。読めなければ送らない
  const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (v === true) e.setAttribute(k, ''); else if (v != null && v !== false) e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false) e.append(c); return e; };
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { status: r.status }); return j;
  };
  // 本体の口（sign-up・sign-in・claim）。本体の失敗は { code, message } なので code を出す
  const coreApi = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || j.code || String(r.status)), { status: r.status }); return j;
  };
  const STEPS = ['lang', 'owner', 'company', 'ai', 'secretary', 'agents', 'folder', 'done'];
  // AI を選んでいない時は ai の段へ（前の版で秘書まで作った data も、ここに戻して AI を選び直す）
  // 完了した利用者は done のまま（前の版で完了していれば AI の段に戻さない）
  const firstOpen = s => (!s.langSet ? 'lang' : !s.hasOwner || !s.authed ? 'owner' : !s.company ? 'company' : s.done ? 'done' : !s.ai?.chosen ? 'ai' : !s.secretaryId ? 'secretary' : s.agentsDone ? 'folder' : 'agents');
  // 画面の key（辞書の ai_<key>）。表に無い AI は type のまま
  const AI_KEY = { codex_local: 'chatgpt', claude_local: 'claude' };

  async function load() { S = await api('GET', '/setup/api/state');
    // 招かれた人（持ち主でない member）は wizard に止めずオフィスへ（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2）
    if (S.done && S.member && !S.authed && S.stage === 'ready') { location.href = '/'; return; } if (!step || (step !== 'lang' && STEPS.indexOf(step) < STEPS.indexOf(firstOpen(S)))) step = firstOpen(S); render(); }

  function frame(id, ...body) {
    document.documentElement.lang = S.lang || 'en'; document.title = t('title');
    const idx = STEPS.indexOf(id);
    app.replaceChildren(...[
      el('h1', {}, t('title')),
      el('ol', { class: 'steps' }, STEPS.map((k, i) => el('li', { class: i === idx ? 'on' : i < idx ? 'done' : '' }, t(`step_${k}`)))),
      S.volume === false ? el('div', { class: 'warn', role: 'alert' }, t('volume_warn')) : null,
      el('section', { class: 'card', 'data-step': id }, el('h2', {}, t(`step_${id}`)), ...body)].filter(Boolean)); // 出さない欄（null）を文字にしない
  }
  const errBox = () => el('div', { class: 'err', role: 'alert' });
  const showErr = (box, e) => { box.textContent = D.en[e.message] ? t(e.message) : `${t('error')} ${e.message}`; };
  const go = s => { step = s; render(); };
  // 担当ごとに使う AI を選ぶ欄（AI の段で選んだ AI の中から）
  const aiSelect = id => {
    const sel = S.ai?.selected || [];
    if (sel.length < 2) return null;
    return el('label', { class: 'muted' }, `${t('agent_ai')} `, el('select', { 'data-agent-ai': id }, sel.map(type => el('option', { value: type }, AI_KEY[type] ? t(`ai_${AI_KEY[type]}`) : (S.ai?.names?.[type] || type)))));
  };
  const pickedAi = (root, id) => root.querySelector(`select[data-agent-ai="${id}"]`)?.value;
  const busy = (btn, fn) => async () => { btn.disabled = true; const old = btn.textContent; btn.textContent = t('saving'); try { await fn(); } finally { btn.disabled = false; btn.textContent = old; } };

  const VIEWS = {
    lang() {
      const pick = l => async () => { S = await api('POST', '/setup/api/lang', { lang: l, timeZone: browserTimeZone() }); go('owner'); };
      frame('lang', el('p', { class: 'muted' }, t('lang_help')),
        el('div', { class: 'row' }, el('button', { class: 'primary', 'data-lang': 'en', on: { click: pick('en') } }, t('lang_en')), el('button', { class: 'primary', 'data-lang': 'ja', on: { click: pick('ja') } }, t('lang_ja'))));
    },
    owner() {
      const box = errBox();
      const field = (id, type, label, auto) => [el('label', { for: id }, t(label)), el('input', { type, id, autocomplete: auto })];
      const val = id => app.querySelector(`#${id}`)?.value || '';
      // ログインのある形（設計 2.3）: 持ち主がまだいない → code とアカウントを作る。いる → 本体のアカウントで sign-in（鍵が無ければ作り直す）
      // 前の版の office の移し替え（設計 docs/design/2026-11-23-public-office-multi-user.md 2.4）。合言葉で入った後に段ごとに進む
      if (S.stage === 'migrating' && S.authed && S.migration) {
        const m = S.migration, again = () => setTimeout(() => load().catch(() => {}), 3000);
        if (m.step === 'backup') { if (!m.error) again(); return frame('owner', el('p', { class: 'muted' }, t('mig_backup')), m.error ? el('div', { class: 'err', role: 'alert' }, t(m.error)) : null); }
        if (m.step === 'lost') return frame('owner', el('p', { class: 'muted' }, t('mig_lost')), el('div', { class: 'code' }, t('mig_reset_cmd')), ...field('email', 'email', 'owner_email', 'email'), ...field('pw1', 'password', 'password', 'current-password'), box,
          el('div', { class: 'row' }, el('span'), el('button', { class: 'primary', id: 'mig-signin', on: { click: async () => { try { await coreApi('/api/auth/sign-in/email', { email: val('email'), password: val('pw1') }); await load(); } catch (e) { showErr(box, e); } } } }, t('next'))));
        if (m.step === 'claim') {
          const btn = el('button', { class: 'primary', id: 'mig-claim' }, t('next'));
          btn.addEventListener('click', busy(btn, async () => {
            if (val('pw1') !== val('pw2')) return showErr(box, new Error('password_mismatch'));
            try { await coreApi('/api/auth/sign-up/email', { name: val('oname'), email: val('email'), password: val('pw1') }); await api('POST', '/setup/api/migrate/claim'); await api('POST', '/setup/api/launcher-key'); await load(); } catch (e) { showErr(box, e); }
          }));
          return frame('owner', el('p', { class: 'muted' }, t('mig_claim')), ...field('oname', 'text', 'owner_name', 'name'), ...field('email', 'email', 'owner_email', 'email'), ...field('pw1', 'password', 'password', 'new-password'), ...field('pw2', 'password', 'password_again', 'new-password'), box, el('div', { class: 'row' }, el('span'), btn));
        }
        if (m.step === 'key') {
          const btn = el('button', { class: 'primary', id: 'mig-key' }, t('next'));
          btn.addEventListener('click', busy(btn, async () => { try { await api('POST', '/setup/api/launcher-key'); await load(); } catch (e) { showErr(box, e); } }));
          return frame('owner', el('p', { class: 'muted' }, t('mig_key')), box, el('div', { class: 'row' }, el('span'), btn));
        }
        const relink = el('input', { type: 'checkbox', id: 'mig-relink', checked: true });
        const btn = el('button', { class: 'primary', id: 'mig-finish' }, t('next'));
        btn.addEventListener('click', busy(btn, async () => { try { await api('POST', '/setup/api/migrate/finish', { relink: relink.checked }); /* 503 は not_ready の文が出る・もう一度押す */ setTimeout(() => { location.href = '/setup/'; }, 4000); } catch (e) { showErr(box, e); } }));
        return frame('owner', el('p', { class: 'muted' }, t('mig_finish')), el('label', {}, relink, ` ${t('mig_relink')}`), box, el('div', { class: 'row' }, el('span'), btn));
      }
      if (S.stage === 'starting') { setTimeout(() => load().catch(() => {}), 3000); return frame('owner', el('p', { class: 'muted' }, t('not_ready'))); }
      // reset-owner の途中は、wizard からは入れない（今回の招待の画面から入る・11 回目のレビュー P3-1）
      if (S.stage === 'preclaim' && S.resetPending) return frame('owner', el('p', { class: 'muted' }, t('reset_in_progress')));
      if (S.stage === 'preclaim') {
        const btn = el('button', { class: 'primary', id: 'owner-next' }, t('next'));
        btn.addEventListener('click', busy(btn, async () => {
          if (val('pw1') !== val('pw2')) return showErr(box, new Error('password_mismatch'));
          try {
            if (!S.claimCode) await api('POST', '/setup/api/claim-code', { code: val('code') });
            await coreApi('/api/auth/sign-up/email', { name: val('oname'), email: val('email'), password: val('pw1') });
            await coreApi('/api/bootstrap/claim', {});
            await api('POST', '/setup/api/launcher-key');
            await load(); go('company');
          } catch (e) { showErr(box, e); }
        }));
        return frame('owner', el('p', { class: 'muted' }, t('owner_account_help')),
          ...(S.claimCode ? [] : [el('p', { class: 'muted' }, t('owner_code_help')), ...field('code', 'text', 'owner_code', 'off')]),
          ...field('oname', 'text', 'owner_name', 'name'), ...field('email', 'email', 'owner_email', 'email'),
          ...field('pw1', 'password', 'password', 'new-password'), ...field('pw2', 'password', 'password_again', 'new-password'), box,
          el('div', { class: 'row' }, el('button', { on: { click: () => go('lang') } }, t('back')), btn));
      }
      if (S.stage === 'ready' || S.stage === 'keyless') {
        const btn = el('button', { class: 'primary', id: 'login' }, t('next'));
        btn.addEventListener('click', busy(btn, async () => {
          try {
            await coreApi('/api/auth/sign-in/email', { email: val('email'), password: val('pw1') });
            await load();
            if (S.authed && !S.keyReady) { await api('POST', '/setup/api/launcher-key'); await load(); }
          } catch (e) { showErr(box, e); }
        }));
        return frame('owner', el('p', { class: 'muted' }, t(S.stage === 'keyless' ? 'owner_key_help' : 'owner_signin_help')), ...field('email', 'email', 'owner_email', 'email'), ...field('pw1', 'password', 'password', 'current-password'), box, el('div', { class: 'row' }, el('span'), btn));
      }
      const p1 = el('input', { type: 'password', id: 'pw1', autocomplete: S.hasOwner ? 'current-password' : 'new-password' });
      if (S.hasOwner) { // 登録の後: 合言葉の入力
        const btn = el('button', { class: 'primary', id: 'login' }, t('next'));
        btn.addEventListener('click', busy(btn, async () => { try { await api('POST', '/setup/api/login', { password: p1.value }); await load(); } catch (e) { showErr(box, e); } }));
        return frame('owner', el('p', { class: 'muted' }, t('owner_login')), el('label', { for: 'pw1' }, t('password')), p1, box, el('div', { class: 'row' }, el('span'), btn));
      }
      const p2 = el('input', { type: 'password', id: 'pw2', autocomplete: 'new-password' }), btn = el('button', { class: 'primary', id: 'owner-next' }, t('next'));
      btn.addEventListener('click', busy(btn, async () => {
        if (p1.value !== p2.value) return showErr(box, new Error('password_mismatch'));
        try { await api('POST', '/setup/api/owner', { password: p1.value }); await load(); go('company'); } catch (e) { showErr(box, e); }
      }));
      frame('owner', el('p', { class: 'muted' }, t('owner_help')), el('label', { for: 'pw1' }, t('password')), p1, el('label', { for: 'pw2' }, t('password_again')), p2, box,
        el('div', { class: 'row' }, el('button', { on: { click: () => go('lang') } }, t('back')), btn));
    },
    company() {
      const box = errBox(), name = el('input', { type: 'text', id: 'company', maxlength: '80', value: S.company?.name || '' }), btn = el('button', { class: 'primary', id: 'company-next' }, t('next'));
      btn.addEventListener('click', busy(btn, async () => { try { S = await api('POST', '/setup/api/company', { name: name.value }); go('ai'); } catch (e) { showErr(box, e); } }));
      frame('company', el('p', { class: 'muted' }, t('company_help')), el('label', { for: 'company' }, t('company_name')), name, box, el('div', { class: 'row' }, el('span'), btn));
    },
    secretary() {
      const box = errBox(), name = el('input', { type: 'text', id: 'secretary', maxlength: '60', placeholder: t('secretary_placeholder') }), btn = el('button', { class: 'primary', id: 'secretary-next' }, t('next'));
      const pick = aiSelect('secretary'), wrap = el('div', {}, pick);
      btn.addEventListener('click', busy(btn, async () => { try { S = await api('POST', '/setup/api/secretary', { name: name.value, ai: pickedAi(wrap, 'secretary') }); go('agents'); } catch (e) { showErr(box, e); } }));
      frame('secretary', el('p', { class: 'muted' }, t('secretary_help')), el('label', { for: 'secretary' }, t('secretary_name')), name, wrap, box,
        el('div', { class: 'row' }, el('button', { on: { click: () => go('ai') } }, t('back')), btn));
    },
    ai() {
      // 使う AI を選ぶ段: Paperclip の adapter の一覧を表の名前で出し、AI ごとにダウンロード → つなぐ → 使う
      const box = errBox(), list = el('div', { id: 'ai-list' });
      const used = new Set(S.ai?.selected || []);
      const picked = new Map(); // 利用者が付け外しした「使う」（描き直しても戻さない）
      let codeDraft = ''; // 貼った code（描き直しても消さない）
      const keyDrafts = new Map(), openKeys = new Set(); // 打ちかけの API の鍵と、開いた鍵の欄（描き直しても消さない・閉じない）
      let lastSig = null;
      const nameOf = a => AI_KEY[a.type] ? t(`ai_${AI_KEY[a.type]}`) : (a.name?.[S.lang] || a.name?.en || a.type);
      const act = (url, body) => async ev => { const btn = ev?.currentTarget; if (btn) btn.disabled = true; box.textContent = ''; try { await api('POST', url, body); lastSig = null; await showList(); } catch (e) { showErr(box, e); if (btn) btn.disabled = false; } };
      const row = a => {
        const key = AI_KEY[a.type] || a.type, kids = [el('b', {}, nameOf(a))];
        if (!a.selectable) return el('div', { class: 'choice ai-row muted', 'data-ai': key, 'data-ai-state': 'unknown' }, el('div', { class: 'ai-head' }, ...kids, el('p', { class: 'muted' }, t('ai_unknown_note'))));
        const inst = a.install?.status || 'pending';
        const use = el('input', { type: 'checkbox', 'data-ai-use': a.type, checked: a.connected && (picked.has(a.type) ? picked.get(a.type) : (used.has(a.type) || !used.size)), disabled: !a.connected, 'aria-label': `${t('ai_use')}: ${nameOf(a)}` });
        use.addEventListener('change', () => picked.set(a.type, use.checked));
        kids.unshift(el('label', {}, use, ` ${t('ai_use')}`));
        let panel = [];
        if (a.connected) kids.push(el('p', { class: 'ok', 'data-ai-connected': a.type }, t(a.viaKey ? 'ai_connected_key' : 'ai_connected')));
        // 鍵でつないだ AI は、鍵の入れ直しと契約のサインインを出し続ける（間違えた鍵を直せるように・契約へ移れるように）
        if (a.connected && !a.viaKey) { /* 契約でつないだ */ }
        else if (inst !== 'done') kids.push(inst === 'running' ? el('p', { class: 'muted' }, t('ai_installing'))
          : el('div', {}, inst === 'failed' ? el('p', { class: 'err' }, t('ai_install_failed')) : null, el('button', { 'data-ai-install': a.type, on: { click: act('/setup/api/ai/install', { type: a.type }) } }, t('ai_install'))));
        else if (!a.loginReady) kids.push(el('p', { class: 'muted' }, t('ai_not_ready_note')));
        else { const v = connectView(a); kids.push(...v.head); panel = v.panel; }
        // 1 行目は「使う」・名前・状態かボタン。つなぐ途中の部品（リンク・code の欄・ボタン）は下の段に縦に並べる
        return el('div', { class: 'choice ai-row', 'data-ai': key, 'data-ai-state': a.connected ? 'connected' : inst }, el('div', { class: 'ai-head' }, ...kids), panel.length ? el('div', { class: 'ai-panel' }, ...panel) : null);
      };
      // API の鍵の欄（表に keyEnv がある AI）。契約でつなげない時の代わり。gemini は鍵だけなので開いておく
      const keyForm = a => {
        if (!a.keyReady) return [];
        const inp = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-ai-key': a.type, 'aria-label': `${t('ai_key_label')}: ${nameOf(a)}` });
        inp.value = keyDrafts.get(a.type) || '';
        inp.addEventListener('input', () => keyDrafts.set(a.type, inp.value));
        const save = el('button', { 'data-ai-key-save': a.type }, t('ai_key_save'));
        // 保存できた時だけ打った鍵を捨てて欄を閉じる（失敗の時は残して直せるように）
        save.addEventListener('click', async () => {
          save.disabled = true; box.textContent = '';
          try { await api('POST', '/setup/api/ai/key', { type: a.type, key: inp.value }); keyDrafts.delete(a.type); openKeys.delete(a.type); lastSig = null; await showList(); }
          catch (e) { showErr(box, e); save.disabled = false; }
        });
        const box2 = el('details', { 'data-ai-key-box': a.type, ...(a.login === 'api_key' || openKeys.has(a.type) ? { open: '' } : {}) }, el('summary', {}, t(a.viaKey ? 'ai_key_replace' : 'ai_key_open')), el('p', { class: 'muted' }, t('ai_key_note')), el('div', { class: 'row' }, inp, save));
        box2.addEventListener('toggle', () => { if (box2.open) openKeys.add(a.type); else openKeys.delete(a.type); });
        return [box2];
      };
      const connectView = a => {
        if (a.login === 'api_key') return { head: [], panel: keyForm(a) };
        if (LIST.logins?.[a.type]) {
          // device code（grok・kimi・pi・opencode）とブラウザで許可する形（cursor）。URL を開き、device なら code を写す
          const c = LIST.logins[a.type];
          if (c.state === 'starting') return { head: [el('p', { class: 'muted' }, t('ai_starting'))], panel: [] };
          if (c.state === 'waiting') {
            const cancel = el('button', { 'data-ai-cancel': a.type, on: { click: act('/setup/api/ai/cancel', { type: a.type }) } }, t('ai_cancel'));
            return { head: [], panel: [el('p', {}, t(a.login === 'device' ? 'ai_device_open' : 'ai_browser_open')), el('p', {}, el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', 'data-ai-url': a.type }, c.url)),
              ...(a.login === 'device' ? [el('p', {}, t('ai_device_code')), el('div', { class: 'code', 'data-ai-device-code': a.type }, c.code)] : [el('p', { class: 'muted' }, t('ai_browser_note'))]), el('div', { class: 'row' }, cancel)] };
          }
          return { head: [el('button', { class: 'primary', 'data-ai-connect': a.type, on: { click: act('/setup/api/ai/start', { type: a.type }) } }, c.state === 'failed' || c.state === 'expired' ? t('ai_retry') : t('ai_connect'))], panel: [...failNote(c), ...keyForm(a)] };
        }
        if (a.type === 'codex_local') {
          const c = LIST.codex || {};
          if (c.state === 'waiting') return { head: [], panel: [el('p', {}, t('codex_open')), el('p', {}, el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', id: 'codex-url' }, c.url)), el('p', {}, t('codex_code')), el('div', { class: 'code', id: 'codex-code' }, c.code)] };
          return { head: [el('button', { class: 'primary', 'data-ai-connect': a.type, on: { click: act('/setup/api/ai/start', { type: a.type }) } }, t('ai_connect'))], panel: [...failNote(c), ...keyForm(a)] };
        }
        const c = LIST.claude || {};
        if (c.state === 'starting') return { head: [el('p', { class: 'muted' }, t('ai_starting'))], panel: [] };
        if (c.state === 'waiting' || c.state === 'submitting') {
          // code は長い（Anthropic の画面で 2 行になる）。全部見える幅の欄にし、文字数も出して貼れたかを確かめられるようにする
          const code = el('textarea', { id: 'ai-code', class: 'code-input', rows: '3', autocomplete: 'off', spellcheck: 'false', 'data-ai-code': a.type, disabled: c.state === 'submitting' });
          code.value = codeDraft;
          const count = el('p', { class: 'muted', 'data-ai-code-count': a.type }, t('ai_code_count').replace('{n}', String(codeDraft.trim().length)));
          code.addEventListener('input', () => { codeDraft = code.value; count.textContent = t('ai_code_count').replace('{n}', String(code.value.trim().length)); });
          const cancel = el('button', { 'data-ai-cancel': a.type, on: { click: act('/setup/api/ai/cancel', { type: a.type }) } }, t('ai_cancel'));
          const send = el('button', { class: 'primary', 'data-ai-send': a.type, disabled: c.state === 'submitting' }, c.state === 'submitting' ? t('ai_sending') : t('ai_send_code'));
          send.addEventListener('click', act('/setup/api/ai/code', { type: a.type, get code() { return code.value; } }));
          return { head: [], panel: [el('p', {}, el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', id: 'ai-url' }, t('ai_open_link'))), el('label', { for: 'ai-code' }, t('ai_paste_code')), code, count, c.state === 'submitting' ? el('p', { class: 'muted' }, t('ai_checking_note')) : null, el('div', { class: 'row' }, cancel, send)] };
        }
        return { head: [el('button', { class: 'primary', 'data-ai-connect': a.type, on: { click: act('/setup/api/ai/start', { type: a.type }) } }, c.state === 'failed' || c.state === 'expired' ? t('ai_retry') : t('ai_connect'))], panel: [...failNote(c), ...keyForm(a)] };
      };
      // つなげなかった理由を、つなぐボタンの下に出す（断られた・答えが無い・期限切れ）
      const FAIL_KEY = { code_rejected: 'ai_code_rejected', login_timeout: 'ai_login_timeout' };
      const failNote = c => (c.state === 'failed' ? [el('p', { class: 'err', 'data-ai-error': c.error || 'failed' }, t(FAIL_KEY[c.error] || 'ai_failed'), c.error ? el('span', { class: 'muted' }, ` (${c.error})`) : null)] : c.state === 'expired' ? [el('p', { class: 'err' }, t('ai_expired'))] : []);
      let LIST = { ais: [] };
      async function showList() {
        LIST = await api('GET', '/setup/api/ai');
        if (step !== 'ai') return;
        // 状態が変わった時だけ描き直す（残り時間だけの違いでは描き直さない。貼りかけの code と focus を消さない）
        const strip = o => JSON.stringify(o, (k, v) => (k === 'remainingMs' ? undefined : v));
        const sig = strip(LIST);
        if (sig !== lastSig) { lastSig = sig; if (!['waiting', 'submitting'].includes(LIST.claude?.state)) codeDraft = ''; list.replaceChildren(...LIST.ais.map(row)); }
        const moving = LIST.ais.some(a => a.install?.status === 'running') || Object.values(LIST.logins || {}).some(v => ['starting', 'waiting'].includes(v?.state)) || ['starting', 'waiting', 'submitting'].includes(LIST.codex?.state) || ['starting', 'waiting', 'submitting'].includes(LIST.claude?.state);
        clearTimeout(poll); if (moving) poll = setTimeout(() => { if (step === 'ai') showList(); }, 2000); // ダウンロードとサインインを待つ
      }
      const next = el('button', { class: 'primary', id: 'ai-next' }, t('next'));
      next.addEventListener('click', busy(next, async () => {
        const types = [...list.querySelectorAll('input[data-ai-use]')].filter(i => i.checked && !i.disabled).map(i => i.getAttribute('data-ai-use'));
        try { S = await api('POST', '/setup/api/ai/choose', { types }); await leave('secretary')(); } catch (e) { showErr(box, e); }
      }));
      const later = el('button', { id: 'ai-later', on: { click: async () => { try { S = await api('POST', '/setup/api/ai/choose', { types: [], later: true }); await leave('secretary')(); } catch (e) { showErr(box, e); } } } }, t('ai_later'));
      // 段を離れる時は、待っている Claude のサインインを止める（PTY を 15 分残さない）
      const leave = to => async () => { if (['starting', 'waiting'].includes(LIST.claude?.state)) { try { await api('POST', '/setup/api/ai/cancel', { type: 'claude_local' }); } catch { /* 止められなくても進む */ } } go(to); };
      frame('ai', el('p', { class: 'muted' }, t('ai_help')), list, box, el('div', { class: 'row' }, el('button', { on: { click: leave('company') } }, t('back')), later, next));
      showList().catch(e => showErr(box, e));
    },
    codex() {
      const c = S.codex || { state: 'idle' }, box = errBox();
      const start = el('button', { class: 'primary', id: 'codex-start' }, c.state === 'expired' || c.state === 'failed' || c.state === 'cancelled' ? t('codex_retry') : t('codex_start'));
      start.addEventListener('click', busy(start, async () => { try { await api('POST', c.state === 'idle' ? '/setup/api/codex/start' : '/setup/api/codex/restart'); await load(); } catch (e) { showErr(box, e); } }));
      const next = el('button', { class: c.state === 'done' ? 'primary' : '', id: 'codex-next', on: { click: () => go('agents') } }, c.state === 'done' ? t('next') : t('codex_skip'));
      const mins = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
      const body = c.state === 'done' ? [el('p', { class: 'ok', 'data-codex': 'done' }, t('codex_done'))]
        : c.state === 'waiting' ? [el('p', {}, t('codex_open')), el('p', {}, el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', id: 'codex-url' }, c.url)),
            el('p', {}, t('codex_code')), el('div', { class: 'code', id: 'codex-code' }, c.code), el('p', { class: 'muted' }, `${t('codex_wait')} ${t('codex_left')} ${mins(c.remainingMs || 0)}`)]
        : c.state === 'starting' ? [el('p', { class: 'muted' }, '…')]
        : [el('p', { class: 'muted' }, t('codex_help')), c.state === 'expired' ? el('p', { class: 'err' }, t('codex_expired')) : null, c.state === 'failed' ? el('p', { class: 'err' }, t(c.error === 'codex_missing' ? 'codex_missing' : 'codex_failed')) : null, start];
      frame('codex', ...body, box, el('div', { class: 'row' }, el('button', { on: { click: () => go('secretary') } }, t('back')), next));
      clearTimeout(poll); if (c.state === 'waiting' || c.state === 'starting') poll = setTimeout(() => { if (step === 'codex') load(); }, 2000); // code が入るのを待つ
    },
    agents() {
      const box = errBox(), boxes = (S.templates || []).map(x => el('div', { class: 'choice' }, el('label', {}, el('input', { type: 'checkbox', value: x.id, checked: x.added, disabled: x.added }), el('span', {}, el('b', {}, x.name), el('br'), el('span', { class: 'muted' }, x.title))), x.added ? null : aiSelect(x.id)));
      const btn = el('button', { class: 'primary', id: 'agents-next' }, t('next'));
      btn.addEventListener('click', busy(btn, async () => {
        const ids = boxes.map(b => b.querySelector('input')).filter(i => i.checked && !i.disabled).map(i => i.value);
        const ai = Object.fromEntries(ids.map(id => [id, pickedAi(app, id)]).filter(([, v]) => v));
        try { S = await api('POST', '/setup/api/agents', { ids, ai, done: true }); go('folder'); } catch (e) { showErr(box, e); } // 完了はフォルダの段で
      }));
      frame('agents', el('p', { class: 'muted' }, t('agents_help')), ...boxes, box, el('div', { class: 'row' }, el('button', { on: { click: () => go('secretary') } }, t('back')), btn));
    },
    folder() {
      // 手元のフォルダの .md と .txt を図書室へ（起動のコマンドは変えない・フォルダの欄の範囲）。送っている間は飛ばせない
      const lib = S.library || 'pending', box = errBox(), out = el('div', { id: 'folder-result' });
      let plan = null, sending = false, sentAll = false, results = [];
      const finish = async () => { try { S = await api('POST', '/setup/api/finish'); go('done'); } catch (e) { showErr(box, e); } };
      const skip = el('button', { id: 'folder-skip', on: { click: () => { if (!sending) finish(); } } }, t('folder_skip'));
      const put = el('button', { class: 'primary', id: 'folder-put', disabled: true }, t('folder_put'));
      const reasons = (counts, prefix) => Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => el('li', { 'data-why': k }, `${t(prefix + k)}: ${n}`));
      const pickEl = el('input', { type: 'file', id: 'folder-input', webkitdirectory: true, directory: true, multiple: true, disabled: lib !== 'ready' });
      const showPlan = () => {
        const skipped = plan ? reasons(plan.skipped, 'folder_why_') : [];
        out.replaceChildren(
          plan ? el('p', { 'data-folder-ready': plan.take.length }, `${t('folder_ready_n')} ${plan.take.length}`) : null,
          skipped.length ? el('div', {}, el('p', { class: 'muted' }, t('folder_skipped')), el('ul', { 'data-folder-skipped': '1' }, skipped)) : null,
          plan && plan.take.length ? el('p', { class: 'muted' }, t('folder_overwrite')) : null);
        put.disabled = !plan || !plan.take.length || sending;
      };
      pickEl.addEventListener('change', async () => {
        if (sending) return; // 送っている間は選び直せない（選ぶ欄も止める・codex P2-2）
        const F = await import('/setup/folder-pick.js');
        sentAll = false; results = []; box.textContent = ''; // 選び直したら、前の結果とボタンの状態を戻す
        plan = F.planFolder([...pickEl.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
        showPlan();
      });
      put.addEventListener('click', async () => {
        if (!plan || sending) return;
        const cur = plan; // 送る物は押した時の選択に固定する
        sending = true; put.disabled = true; skip.disabled = true; pickEl.disabled = true; box.textContent = '';
        const F = await import('/setup/folder-pick.js');
        try {
          const docs = [];
          for (const x of cur.take) docs.push({ name: x.name, text: await x.file.text() });
          const { batches, tooBig } = F.toBatches(docs);
          const skippedNow = { ...cur.skipped, size: cur.skipped.size + tooBig.length }; // plan は書き換えない（やり直しで数が増えない・実装レビュー P3-1）
          results = [];
          for (let i = 0; i < batches.length; i += 1) {
            out.replaceChildren(el('p', { id: 'folder-progress' }, `${t('folder_progress')} ${i + 1} / ${batches.length}`));
            const r = await api('POST', '/setup/api/library/folder', { docs: batches[i] }); // 束は 1 つずつ順に送る
            results.push(...(r.results || []));
          }
          const sum = F.tally(results), refused = reasons(sum.refused, '');
          const skipped = reasons(skippedNow, 'folder_why_');
          out.replaceChildren(el('p', { class: 'ok', 'data-folder-done': sum.put }, `${t('folder_done_n')} ${sum.put}`),
            skipped.length || refused.length ? el('div', {}, el('p', { class: 'muted' }, t('folder_skipped')), el('ul', { 'data-folder-skipped': '1' }, skipped, refused)) : null);
          sentAll = true;
        } catch (e) { showErr(box, e); if (results.length) out.replaceChildren(el('p', { 'data-folder-partial': F.tally(results).put }, `${t('folder_done_n')} ${F.tally(results).put}`)); } // 途中までに置けた数を残す（P3-2）
        sending = false; skip.disabled = false; pickEl.disabled = false;
        if (sentAll) { skip.textContent = t('folder_next'); skip.className = 'primary'; skip.id = 'folder-next'; put.disabled = true; } else put.disabled = !cur.take.length;
      });
      const body = lib === 'ready' ? [el('label', { for: 'folder-input' }, t('folder_pick')), pickEl, out]
        : lib === 'failed' ? [el('p', { class: 'warn', role: 'alert', id: 'folder-unavailable' }, t('folder_unavailable'))]
        : [el('p', { class: 'muted', id: 'folder-preparing' }, t('folder_preparing'))];
      frame('folder', el('p', { class: 'muted' }, t('folder_help')), ...body, box, el('div', { class: 'row' }, skip, lib === 'ready' ? put : el('span')));
      clearTimeout(poll); if (lib === 'pending') poll = setTimeout(() => { if (step === 'folder') load(); }, 2000); // 図書室が入るのを待つ
    },
    done() {
      // office の画面（plugin）が ready なら /<prefix>/office、入れている途中は待ち、失敗なら Dashboard（/）へ
      const office = S.office || 'pending', prefix = S.company?.prefix;
      const href = office === 'ready' && prefix ? `/${encodeURIComponent(prefix)}/office` : '/';
      const open = office === 'pending'
        ? el('button', { class: 'primary', id: 'open-office', disabled: true }, t('office_preparing'))
        : el('a', { href, id: 'open-office', class: 'btn primary', 'data-office': office }, t('open_office')); // リンクをボタンの形の a 1 つにする（a の中に button を入れない・範囲 2026-11-18 F10）
      frame('done', el('p', {}, t('done_help')),
        (S.noInstructions || []).length ? el('p', { class: 'warn', role: 'alert', id: 'no-instructions' }, `${t('no_instructions')} ${S.noInstructions.join(', ')}`) : null,
        office === 'failed' ? el('p', { class: 'warn', role: 'alert', id: 'office-failed' }, t('office_failed')) : null,
        Object.values(S.rounds || {}).some(r => r && (r.late || r.lastError)) ? el('p', { class: 'warn', role: 'alert', id: 'rounds-late' }, t('rounds_late')) : null,
        el('div', { class: 'row' }, el('span'), open));
      clearTimeout(poll); if (office === 'pending') poll = setTimeout(() => { if (step === 'done') load(); }, 2000);
    },
  };
  function render() { (VIEWS[step] || VIEWS.lang)(); }

  (async () => { try { D = await api('GET', '/setup/api/i18n'); await load(); } catch (e) { app.textContent = String(e.message); } })();
})();
