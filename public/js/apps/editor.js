/* ============ Editor — text/markdown editor on the virtual FS ============ */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function mk(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }

  WebOS.registerApp({
    id: 'editor', name: 'Editor', icon: '📝', width: 820, height: 580,
    mount(a) {
      let path = (a.args && (a.args.path || a.args.arg)) || null;
      let dirty = false;

      const root = a.win.body;
      const toolbar = mk('div', 'toolbar');
      toolbar.innerHTML = `
        <button class="tb-btn" data-a="new">＋ New</button>
        <button class="tb-btn" data-a="open">📂 Open</button>
        <button class="tb-btn primary" data-a="save">💾 Save</button>
        <button class="tb-btn" data-a="saveas">Save as…</button>
        <button class="tb-btn" data-a="download">⤓</button>
        <button class="tb-btn" data-a="preview">👁 Preview</button>
        <input class="inp mono" id="pathin" placeholder="/Home/Documents/notes.txt" spellcheck="false">`;
      const area = mk('textarea', 'editor');
      area.spellcheck = false;
      const status = mk('div', 'statusbar');
      root.appendChild(toolbar); root.appendChild(area); root.appendChild(status);

      const pathin = toolbar.querySelector('#pathin');
      pathin.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathin.value.trim()); });
      area.addEventListener('input', () => { dirty = true; setStatus(); });

      toolbar.addEventListener('click', async (e) => {
        const act = e.target.dataset && e.target.dataset.a;
        if (!act) return;
        if (act === 'new') { path = null; area.value = ''; dirty = false; pathin.value = ''; a.setTitle('Editor', 'untitled'); setStatus(); }
        if (act === 'open') {
          const p = await WebOS.prompt('Open file path', path || '/Home/Documents/welcome.txt');
          if (p) load(p);
        }
        if (act === 'save') {
          let p = path;
          if (!p) { p = await WebOS.prompt('Save as path', '/Home/Documents/untitled.txt'); if (!p) return; }
          const r = await WebOS.api.fs.write(p, area.value);
          if (r.error) { WebOS.notify(r.error, 'err', 'save failed'); return; }
          path = p; pathin.value = p; dirty = false;
          a.setTitle('Editor', p.split('/').pop());
          WebOS.notify('Saved ' + p, 'ok', 'editor');
          setStatus();
          a.publishState({ path, bytes: area.value.length, dirty: false });
        }
        if (act === 'saveas') {
          const p = await WebOS.prompt('Save as path', path || '/Home/Documents/untitled.txt');
          if (!p) return;
          path = p; pathin.value = p;
          const r = await WebOS.api.fs.write(p, area.value);
          if (!r.error) { dirty = false; WebOS.notify('Saved ' + p, 'ok', 'editor'); }
          setStatus();
        }
        if (act === 'download') {
          const blob = new Blob([area.value], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const l = document.createElement('a');
          l.href = url; l.download = (path || 'untitled.txt').split('/').pop(); l.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        }
        if (act === 'preview') togglePreview();
      });

      /* markdown-ish preview */
      let previewing = false;
      const previewEl = mk('div', 'doc');
      previewEl.style.cssText = 'flex:1;overflow:auto;padding:16px';
      previewEl.style.display = 'none';
      root.insertBefore(previewEl, status);
      function mdToHtml(md) {
        let h = esc(md);
        h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>')
             .replace(/^## (.*)$/gm, '<h2>$1</h2>')
             .replace(/^# (.*)$/gm, '<h1>$1</h1>')
             .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
             .replace(/`([^`]+)`/g, '<code>$1</code>')
             .replace(/^\- (.*)$/gm, '<li>$1</li>')
             .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
             .replace(/\n{2,}/g, '</p><p>');
        return '<p>' + h.replace(/\n/g, '<br>') + '</p>';
      }
      function togglePreview() {
        previewing = !previewing;
        area.style.display = previewing ? 'none' : 'block';
        previewEl.style.display = previewing ? 'block' : 'none';
        if (previewing) previewEl.innerHTML = mdToHtml(area.value);
      }

      async function load(p) {
        if (!p) return;
        const r = await WebOS.api.fs.read(p);
        if (r.error) {
          // File abhi exist nahi karta -> naya file banao (path yaad rakho, Save se create ho jayega).
          // Agent ke liye bhi yahi behaviour chahiye: open + edit + save = create.
          if (/no such file/i.test(r.error)) {
            path = p; area.value = ''; dirty = false;
            pathin.value = p;
            a.setTitle('Editor', p.split('/').pop() + ' (new)');
            setStatus();
            a.publishState({ path, bytes: 0, dirty: false, isNew: true });
            return;
          }
          WebOS.notify(r.error, 'err', 'editor');
          return;
        }
        path = r.path; area.value = r.content || ''; dirty = false;
        pathin.value = path;
        a.setTitle('Editor', path.split('/').pop());
        setStatus();
        a.publishState({ path, bytes: area.value.length, dirty: false });
      }

      function setStatus() {
        const lines = area.value.split('\n').length;
        status.innerHTML = `<span>${path ? esc(path) : 'unsaved'}</span><span>${lines} lines · ${area.value.length} chars</span><span>${dirty ? '● unsaved changes' : 'saved'}</span>`;
      }

      if (path) load(path); else { a.setTitle('Editor', 'untitled'); setStatus(); }

      return {
        handleCommand(cmd) {
          const args = cmd.args || {};
          const op = String(cmd.op || '').toLowerCase();
          if (['edit', 'append', 'insert', 'setcontent', 'replace'].includes(op)) {
            if (args.path) path = args.path;
            const text = String(args.text != null ? args.text : args.content != null ? args.content : '');
            if (op === 'append' || op === 'insert') area.value += (area.value.endsWith('\n') || !area.value ? '' : '\n') + text;
            else area.value = text;
            area.dispatchEvent(new Event('input', { bubbles: true }));
            if (args.save) {
              const p = path || args.path;
              if (p) WebOS.api.fs.write(p, area.value).then(() => { dirty = false; setStatus(); });
            }
            return { ok: true, path, bytes: area.value.length };
          }
          if (op === 'read' || op === 'getcontent') {
            return { ok: true, path, content: area.value, bytes: area.value.length, dirty };
          }
          if (op === 'save') {
            if (!path) return { ok: false, error: 'no path — use saveas {path}' };
            WebOS.api.fs.write(path, area.value);
            dirty = false; setStatus();
            return { ok: true, path, bytes: area.value.length };
          }
          if (op === 'saveas') {
            if (!args.path) return { ok: false, error: 'args.path required' };
            path = args.path; pathin.value = path;
            WebOS.api.fs.write(path, area.value);
            dirty = false; setStatus();
            return { ok: true, path };
          }
          if (op === 'preview') { if (!previewing) togglePreview(); return { ok: true }; }
          return null;
        },
        state() { return { path, bytes: area.value.length, dirty }; }
      };
    }
  });
})();
