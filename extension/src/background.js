import { api, getAccessToken } from './auth.js';
import { getConfig } from './config.js';

const POLL_MINUTES = 5;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'hd-page', title: 'Report a problem with this page', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'hd-selection', title: 'Create help desk ticket from “%s”', contexts: ['selection'] });
  chrome.alarms.create('hd-poll', { periodInMinutes: POLL_MINUTES });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('hd-poll', { periodInMinutes: POLL_MINUTES }));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const draft = {
    subject: info.menuItemId === 'hd-selection' ? info.selectionText.slice(0, 120) : `Problem with ${tab?.title ?? 'a web page'}`.slice(0, 200),
    description: info.menuItemId === 'hd-selection' ? `${info.selectionText}\n\n` : '',
    url: tab?.url,
  };
  await chrome.storage.local.set({ draft });
  try {
    await chrome.action.openPopup();
  } catch {
    const cfg = await getConfig();
    if (cfg.apiUrl) chrome.tabs.create({ url: `${cfg.apiUrl}/tickets/new` });
  }
});

/** Poll for updates to the user's tickets and show a badge / notification. */
async function poll() {
  if (!(await getAccessToken())) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  try {
    const { items } = await api('/tickets?view=requested&pageSize=50&sort=updatedAt');
    const { seen = {}, statuses = {} } = await chrome.storage.local.get(['seen', 'statuses']);
    let unread = 0;
    for (const t of items) {
      if (seen[t.id] && new Date(t.updatedAt).getTime() > seen[t.id]) unread++;
      if (statuses[t.id] && statuses[t.id] !== t.status && ['RESOLVED', 'PENDING'].includes(t.status)) {
        chrome.notifications.create(`hd-${t.id}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: `Ticket #${t.id} ${t.status === 'RESOLVED' ? 'resolved' : 'updated'}`,
          message: t.subject,
        });
      }
      statuses[t.id] = t.status;
      if (!seen[t.id]) seen[t.id] = new Date(t.updatedAt).getTime();
    }
    await chrome.storage.local.set({ seen, statuses });
    chrome.action.setBadgeBackgroundColor({ color: '#2a78d6' });
    chrome.action.setBadgeText({ text: unread ? String(unread) : '' });
  } catch (e) {
    console.warn('poll failed', e);
  }
}

chrome.alarms.onAlarm.addListener((a) => a.name === 'hd-poll' && poll());
chrome.notifications.onClicked.addListener(async (id) => {
  const cfg = await getConfig();
  if (id.startsWith('hd-') && cfg.apiUrl) chrome.tabs.create({ url: `${cfg.apiUrl}/tickets/${id.slice(3)}` });
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'poll') poll();
});
