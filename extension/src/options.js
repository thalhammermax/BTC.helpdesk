import { getConfig } from './config.js';

const form = document.getElementById('f');
document.getElementById('redirect').textContent = chrome.identity.getRedirectURL();
const cfg = await getConfig();
const local = await chrome.storage.sync.get(['apiUrl', 'tenantId', 'clientId', 'scope']);
for (const k of ['apiUrl', 'tenantId', 'clientId', 'scope']) form[k].value = (cfg.managed ? cfg[k] : local[k]) || '';
if (cfg.managed) {
  document.getElementById('managed').classList.remove('hidden');
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = true));
}
form.onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(['apiUrl', 'tenantId', 'clientId', 'scope'].map((k) => [k, form[k].value.trim()]));
  await chrome.storage.sync.set(data);
  await chrome.storage.local.remove('tokens');
  document.getElementById('saved').classList.remove('hidden');
};
