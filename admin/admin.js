(() => {
  const $ = s => document.querySelector(s);
  const api = (p, opts = {}) => fetch('/admin/api/' + p, { credentials: 'same-origin', ...opts });
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const els = {
    login: $('#login'), app: $('#app'), loginForm: $('#login-form'), loginError: $('#login-error'),
    messages: $('#messages'), composer: $('#composer'), input: $('#input'), file: $('#file'), atts: $('#attachments'),
    model: $('#model'), send: $('#send'), stop: $('#stop'), undo: $('#undo'), newChat: $('#new-chat'), logout: $('#logout'),
    page: $('#page'), frame: $('#frame'), wrap: $('.frame-wrap'), reload: $('#reload'), open: $('#open'),
    desktop: $('#view-desktop'), phone: $('#view-phone'),
  };
  let busy = false, pending = [], state = null;

  // ---------- markdown (small, safe) ----------
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|[\w\-./]+\.html)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function md(text) {
    const blocks = [];
    text = text.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of esc(text).split('\n')) {
      const line = raw.trimEnd();
      let m;
      if ((m = /^\u0000(\d+)\u0000$/.exec(line))) { close(); html += `<pre><code>${esc(blocks[+m[1]])}</code></pre>`; continue; }
      if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      close();
      if (!line.trim()) continue;
      if ((m = /^#{1,6}\s+(.*)/.exec(line))) { html += `<p><strong>${inline(m[1])}</strong></p>`; continue; }
      html += `<p>${inline(line)}</p>`;
    }
    close();
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => esc(blocks[+i]));
  }

  // ---------- auth ----------
  async function boot() {
    const r = await api('state');
    if (r.status === 401) { els.app.classList.add('hidden'); els.login.classList.remove('hidden'); return; }
    state = await r.json();
    els.login.classList.add('hidden'); els.app.classList.remove('hidden');
    const saved = localStorage.getItem('admin-model');
    els.model.innerHTML = state.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    els.model.value = state.models.some(m => m.id === saved) ? saved : state.model;
    const cur = els.page.value;
    els.page.innerHTML = state.pages.map(p => `<option value="${esc(p)}">${p === 'index.html' ? 'Home' : esc(p.replace(/\.html$/, ''))}</option>`).join('');
    if (cur && state.pages.includes(cur)) els.page.value = cur;
    if (!els.frame.src) loadPage();
    els.undo.disabled = !state.canUndo;
    renderLog(state.log);
    if (state.running) { setBusy(true); pollUntilIdle(); }
    if (!state.aiReady) addSystem('The AI key is missing on the server (OPENROUTER_API_KEY in .env).');
  }
  els.loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    els.loginError.textContent = '';
    const f = new FormData(els.loginForm);
    const r = await post('login', { username: f.get('username'), password: f.get('password') });
    if (!r.ok) { els.loginError.textContent = (await r.json().catch(() => ({}))).error || 'Login failed'; return; }
    els.loginForm.reset();
    boot();
  });
  els.logout.addEventListener('click', async () => { await post('logout'); location.reload(); });

  // ---------- rendering ----------
  const IDEAS = [
    'Make the home page feel more like a gallery: big project images, minimal text, smooth hover effects.',
    'Change the whole colour scheme to warm off-white with deep green accents.',
    'Add a new “Contact” page with my email and Instagram, and link it in the menu.',
    'Make the About page text bigger and easier to read on phones.',
  ];
  function renderLog(log) {
    els.messages.innerHTML = '';
    if (!log.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = `<b>Tell the AI how you want your website to be.</b><br>It edits the real site directly — every change appears in the preview on the right and goes live immediately. If you don't like a change, press <b>↶ Undo</b>.<div class="ideas">${IDEAS.map(i => `<button type="button">${esc(i)}</button>`).join('')}</div>`;
      d.querySelectorAll('.ideas button').forEach(b => b.addEventListener('click', () => { els.input.value = b.textContent; els.input.focus(); autosize(); }));
      els.messages.appendChild(d);
      return;
    }
    for (const m of log) {
      if (m.role === 'user') addUser(m.text, (m.attachments || []).map(a => '/' + a.path));
      else if (m.role === 'system') addSystem(m.text);
      else {
        const v = addAssistant();
        for (const s of m.steps || []) v.addStep(s.label, s.ok);
        v.finishSteps();
        v.setText(m.text || (m.error ? '' : '…'));
        if (m.error) v.setError(m.error);
        v.setMeta(m);
      }
    }
    scrollDown(true);
  }
  function addUser(text, thumbs = []) {
    clearEmpty();
    const d = document.createElement('div');
    d.className = 'msg user';
    d.textContent = text;
    if (thumbs.length) {
      const t = document.createElement('div'); t.className = 'thumbs';
      for (const src of thumbs) { const i = new Image(); i.src = src; t.appendChild(i); }
      d.appendChild(t);
    }
    els.messages.appendChild(d);
    scrollDown(true);
  }
  function addSystem(text) {
    clearEmpty();
    const d = document.createElement('div'); d.className = 'msg system'; d.textContent = text;
    els.messages.appendChild(d); scrollDown();
  }
  function clearEmpty() { const e = els.messages.querySelector('.empty'); if (e) e.remove(); }
  function addAssistant() {
    clearEmpty();
    const d = document.createElement('div'); d.className = 'msg assistant';
    const wrap = document.createElement('details'); wrap.className = 'steps-wrap hidden'; wrap.open = true;
    const sum = document.createElement('summary'); wrap.appendChild(sum);
    const steps = document.createElement('div'); steps.className = 'steps'; wrap.appendChild(steps);
    const text = document.createElement('div'); text.className = 'text';
    const think = document.createElement('div'); think.className = 'thinking hidden'; think.innerHTML = '<i></i><i></i><i></i>';
    const meta = document.createElement('div'); meta.className = 'meta hidden';
    d.append(wrap, text, think, meta);
    els.messages.appendChild(d);
    let raw = '', n = 0, live = null;
    const v = {
      steps,
      addStep(label, ok = true, isLive = false) {
        wrap.classList.remove('hidden');
        const s = document.createElement('div'); s.className = 'step' + (isLive ? ' live' : ok ? '' : ' fail'); s.textContent = label;
        steps.appendChild(s); n++; sum.textContent = `${n} step${n === 1 ? '' : 's'}`;
        scrollDown();
        return s;
      },
      liveStep(label) { if (!live) live = v.addStep(label, true, true); else live.textContent = label; },
      endLive(label, ok) { if (live) { live.className = 'step' + (ok ? '' : ' fail'); live.textContent = label; live = null; } else v.addStep(label, ok); },
      finishSteps() { if (n > 3) wrap.open = false; },
      appendText(t) { raw += t; text.innerHTML = md(raw); scrollDown(); },
      setText(t) { raw = t; text.innerHTML = md(raw); },
      setError(msg) { const e = document.createElement('div'); e.className = 'error'; e.textContent = msg; d.insertBefore(e, think); },
      thinking(on) { think.classList.toggle('hidden', !on); if (on) scrollDown(); },
      setMeta(m) {
        const bits = [];
        if (m.changed && m.changed.length) bits.push(`Changed ${m.changed.length} file${m.changed.length === 1 ? '' : 's'}`);
        if (m.cost) bits.push('$' + m.cost.toFixed(m.cost < 0.1 ? 3 : 2));
        if (bits.length) { meta.textContent = bits.join(' · '); meta.classList.remove('hidden'); }
      },
    };
    return v;
  }
  function scrollDown(force) {
    const m = els.messages;
    if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
  }

  // ---------- sending ----------
  function setBusy(b) {
    busy = b;
    els.send.classList.toggle('hidden', b); els.stop.classList.toggle('hidden', !b);
    els.undo.disabled = b || !(state && state.canUndo); els.newChat.disabled = b;
  }
  els.composer.addEventListener('submit', e => { e.preventDefault(); send(); });
  els.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  els.input.addEventListener('input', autosize);
  function autosize() { els.input.style.height = 'auto'; els.input.style.height = Math.min(els.input.scrollHeight + 2, innerHeight * 0.4) + 'px'; }
  els.model.addEventListener('change', () => localStorage.setItem('admin-model', els.model.value));

  async function send() {
    const text = els.input.value.trim();
    if (busy || (!text && !pending.length)) return;
    const images = pending.slice(); pending = []; renderAtts();
    els.input.value = ''; autosize();
    addUser(text, images.map(i => i.data));
    setBusy(true);
    const v = addAssistant();
    v.thinking(true);
    let changed = false;
    try {
      const r = await post('chat', { message: text, images: images.map(i => ({ name: i.name, data: i.data })), model: els.model.value });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))).error || ('Error ' + r.status);
        if (r.status === 401) return location.reload();
        v.thinking(false); v.setError(err); return;
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'text') { v.thinking(false); v.appendText(ev.text); }
          else if (ev.type === 'tool_start') { v.thinking(false); v.liveStep(toolLabel(ev.name)); }
          else if (ev.type === 'tool_progress') { if (ev.bytes > 2000) v.liveStep(toolLabel(ev.name) + ` (${(ev.bytes / 1024).toFixed(0)} KB)`); }
          else if (ev.type === 'tool') { v.liveStep(ev.label); }
          else if (ev.type === 'tool_done') { v.endLive(ev.label, ev.ok); v.thinking(true); if (ev.changed) { changed = true; scheduleReload(); } }
          else if (ev.type === 'error') { v.thinking(false); v.setError(ev.message); }
          else if (ev.type === 'done') { v.thinking(false); v.finishSteps(); v.setMeta(ev); }
        }
      }
    } catch (e) {
      v.setError('Connection lost: ' + e.message + '. The AI may still be finishing — the page will refresh when it is done.');
      pollUntilIdle();
    } finally {
      v.thinking(false);
      setBusy(false);
      const s = await (await api('state')).json().catch(() => null);
      if (s) { state = s; els.undo.disabled = !s.canUndo; refreshPages(s.pages); }
      if (changed) reloadFrame();
    }
  }
  function toolLabel(name) {
    return ({ list_files: 'Looking at files', read_file: 'Reading a file', write_file: 'Writing a file', edit_file: 'Editing a file', search_files: 'Searching', move_file: 'Moving a file', delete_file: 'Deleting a file' })[name] || name;
  }
  async function pollUntilIdle() {
    for (;;) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await (await api('state')).json().catch(() => null);
      if (s && !s.running) { setBusy(false); state = s; renderLog(s.log); els.undo.disabled = !s.canUndo; reloadFrame(); return; }
    }
  }
  els.stop.addEventListener('click', () => post('stop'));
  els.undo.addEventListener('click', async () => {
    if (!confirm('Undo the AI\'s last change to the website?')) return;
    const r = await (await post('undo')).json();
    if (r.ok) { addSystem(`Undone — ${r.files.length} file${r.files.length === 1 ? '' : 's'} restored.`); state.canUndo = r.canUndo; els.undo.disabled = !r.canUndo; reloadFrame(); }
    else addSystem(r.message || r.error || 'Nothing to undo.');
    const s = await (await api('state')).json().catch(() => null); if (s) refreshPages(s.pages);
  });
  els.newChat.addEventListener('click', async () => {
    if (!confirm('Start a new conversation? Your website stays as it is.')) return;
    await post('new'); renderLog([]);
  });

  // ---------- attachments ----------
  els.file.addEventListener('change', () => { addFiles(els.file.files); els.file.value = ''; });
  els.input.addEventListener('paste', e => { const f = [...e.clipboardData.files].filter(f => f.type.startsWith('image/')); if (f.length) { e.preventDefault(); addFiles(f); } });
  els.composer.addEventListener('dragover', e => e.preventDefault());
  els.composer.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/'))); });
  async function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      pending.push({ name: f.name, data: await shrink(f) });
    }
    renderAtts();
  }
  // Resize large photos in the browser (max 2400px) so uploads stay fast.
  function shrink(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        if (file.type === 'image/svg+xml' || file.type === 'image/gif') return resolve(url);
        const img = new Image();
        img.onload = () => {
          const max = 2400, sc = Math.min(1, max / Math.max(img.width, img.height));
          if (sc === 1 && file.size < 3 * 1024 * 1024) return resolve(url);
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88));
        };
        img.onerror = () => resolve(url);
        img.src = url;
      };
      reader.readAsDataURL(file);
    });
  }
  function renderAtts() {
    els.atts.innerHTML = '';
    pending.forEach((p, i) => {
      const d = document.createElement('div'); d.className = 'att';
      const img = new Image(); img.src = p.data;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove';
      x.onclick = () => { pending.splice(i, 1); renderAtts(); };
      d.append(img, x); els.atts.appendChild(d);
    });
  }

  // ---------- preview ----------
  function pageUrl() { const p = els.page.value || 'index.html'; return '/' + (p === 'index.html' ? '' : p); }
  function loadPage() { els.frame.src = pageUrl(); els.open.href = pageUrl(); }
  function refreshPages(pages) {
    const cur = els.page.value;
    els.page.innerHTML = pages.map(p => `<option value="${esc(p)}">${p === 'index.html' ? 'Home' : esc(p.replace(/\.html$/, ''))}</option>`).join('');
    els.page.value = pages.includes(cur) ? cur : 'index.html';
  }
  let reloadTimer = null;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(reloadFrame, 700); }
  function reloadFrame() {
    let y = 0;
    try { y = els.frame.contentWindow.scrollY; } catch { /* ignore */ }
    els.frame.addEventListener('load', () => { try { setTimeout(() => els.frame.contentWindow.scrollTo(0, y), 150); } catch { /* ignore */ } }, { once: true });
    try { els.frame.contentWindow.location.reload(); } catch { loadPage(); }
  }
  // keep the page picker in sync when navigating inside the preview
  els.frame.addEventListener('load', () => {
    try {
      let p = els.frame.contentWindow.location.pathname.replace(/^\//, '') || 'index.html';
      if (!p.endsWith('.html')) p += '.html';
      if ([...els.page.options].some(o => o.value === p)) els.page.value = p;
      els.open.href = '/' + (p === 'index.html' ? '' : p);
    } catch { /* ignore */ }
  });
  els.page.addEventListener('change', loadPage);
  els.reload.addEventListener('click', reloadFrame);
  els.desktop.addEventListener('click', () => { els.wrap.classList.remove('phone'); els.desktop.classList.add('on'); els.phone.classList.remove('on'); });
  els.phone.addEventListener('click', () => { els.wrap.classList.add('phone'); els.phone.classList.add('on'); els.desktop.classList.remove('on'); });

  boot();
})();
