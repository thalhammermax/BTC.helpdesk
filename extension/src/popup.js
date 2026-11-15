import { api, getAccessToken, signIn, signOut } from './auth.js';
import { getConfig } from './config.js';

const $ = (s) => document.querySelector(s);
const show = (id) => ['#view-config', '#view-signin', '#view-main'].forEach((v) => $(v).classList.toggle('hidden', v !== id));
const label = (s) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let cfg;
let tab;

async function init() {
  cfg = await getConfig();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#open-web').onclick = () => cfg.apiUrl && chrome.tabs.create({ url: cfg.apiUrl });
  $('#open-options').onclick = () => chrome.runtime.openOptionsPage();
  if (!cfg.complete) return show('#view-config');
  if (!(await getAccessToken({ allowSilentFlow: false }))) return show('#view-signin');
  await main();
}

$('#sign-in').onclick = async () => {
  $('#signin-error').classList.add('hidden');
  try {
    await signIn({ interactive: true });
    await main();
  } catch (e) {
    $('#signin-error').textContent = e.message;
    $('#signin-error').classList.remove('hidden');
  }
};
$('#sign-out').onclick = async () => {
  await signOut();
  chrome.action.setBadgeText({ text: '' });
  $('#sign-out').classList.add('hidden');
  show('#view-signin');
};

async function main() {
  show('#view-main');
  $('#sign-out').classList.remove('hidden');
  let me;
  try {
    me = await api('/me');
  } catch (e) {
    if (e.status === 401) return show('#view-signin');
    throw e;
  }
  $('#hd-name').textContent = me.helpdeskName || 'Help Desk';
  if (me.isAgent) $('#tab-assigned').classList.remove('hidden');

  const pageUrl = tab?.url && /^https?:/.test(tab.url) ? tab.url : '';
  $('#page-url').textContent = pageUrl ? `(${new URL(pageUrl).hostname})` : '';
  if (!pageUrl) $('[name=includeUrl]').closest('label').classList.add('hidden');

  // Draft from the right-click menu
  const { draft } = await chrome.storage.local.get('draft');
  if (draft) {
    $('[name=subject]').value = draft.subject || '';
    $('[name=description]').value = draft.description || '';
    await chrome.storage.local.remove('draft');
  }

  api('/categories').then((cats) => {
    for (const c of cats) $('[name=categoryId]').insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
  });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
      if (b.dataset.tab === 'list') loadList('#list', 'requested');
      if (b.dataset.tab === 'assigned') loadList('#assigned', 'mine');
    };
  });
  refreshUnread();
}

async function refreshUnread() {
  try {
    const { items } = await api('/tickets?view=requested&pageSize=50');
    const { seen = {} } = await chrome.storage.local.get('seen');
    const n = items.filter((t) => seen[t.id] && new Date(t.updatedAt).getTime() > seen[t.id]).length;
    $('#unread').textContent = n;
    $('#unread').classList.toggle('hidden', !n);
  } catch { /* ignore */ }
}

async function loadList(sel, view) {
  const el = $(sel);
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { items } = await api(`/tickets?view=${view}&pageSize=30${view === 'requested' ? '' : ''}`);
    const { seen = {} } = await chrome.storage.local.get('seen');
    if (!items.length) {
      el.innerHTML = `<div class="empty">${view === 'mine' ? 'Nothing assigned to you.' : 'You have no tickets yet.'}</div>`;
      return;
    }
    el.innerHTML = items
      .map((t) => {
        const unread = view === 'requested' && seen[t.id] && new Date(t.updatedAt).getTime() > seen[t.id];
        return `<button class="item ${unread ? 'unread' : ''}" data-id="${t.id}" data-updated="${esc(t.updatedAt)}">
          <div class="top"><span class="subj">${esc(t.subject)}</span><span class="badge ${t.status}">${label(t.status)}</span></div>
          <div class="meta">#${t.id} · updated ${ago(t.updatedAt)}${t.assignee ? ` · ${esc(t.assignee.name)}` : ''}</div>
        </button>`;
      })
      .join('');
    el.querySelectorAll('.item').forEach((b) => {
      b.onclick = async () => {
        const { seen = {} } = await chrome.storage.local.get('seen');
        seen[b.dataset.id] = new Date(b.dataset.updated).getTime();
        await chrome.storage.local.set({ seen });
        chrome.runtime.sendMessage('poll');
        chrome.tabs.create({ url: `${cfg.apiUrl}/tickets/${b.dataset.id}` });
      };
    });
  } catch (e) {
    el.innerHTML = `<div class="error" style="margin:14px">${esc(e.message)}</div>`;
  }
}

$('#new-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  $('#new-error').classList.add('hidden');
  $('#new-ok').classList.add('hidden');
  try {
    const body = {
      subject: f.get('subject'),
      description: f.get('description'),
      priority: f.get('priority'),
      categoryId: f.get('categoryId') || undefined,
    };
    if (f.get('includeUrl') && tab?.url && /^https?:/.test(tab.url)) body.sourceUrl = tab.url;
    if (f.get('screenshot')) {
      try {
        body.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      } catch {
        /* some pages (chrome://, Web Store) cannot be captured */
      }
    }
    const t = await api('/tickets', { json: body });
    ev.target.reset();
    $('#new-ok').innerHTML = `Ticket <a href="#" id="new-link">#${t.id}</a> created. We'll email you updates.`;
    $('#new-ok').classList.remove('hidden');
    $('#new-link').onclick = () => chrome.tabs.create({ url: `${cfg.apiUrl}/tickets/${t.id}` });
    const { seen = {} } = await chrome.storage.local.get('seen');
    seen[t.id] = Date.now();
    await chrome.storage.local.set({ seen });
  } catch (e) {
    $('#new-error').textContent = e.message;
    $('#new-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit ticket';
  }
};

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="error" style="margin:14px">${esc(e.message)}</div>`);
});
