// Configuration comes from (in order): Google Admin managed policy → options page → defaults.
let managedPromise;
function readManaged() {
  // storage.managed.get can hang when no policy exists on some platforms, so cap the wait (once per page).
  managedPromise ??= Promise.race([
    chrome.storage.managed.get(null).catch(() => ({})),
    new Promise((r) => setTimeout(() => r({}), 400)),
  ]);
  return managedPromise;
}

export async function getConfig() {
  const managed = await readManaged();
  const local = await chrome.storage.sync.get(['apiUrl', 'tenantId', 'clientId', 'scope']);
  const cfg = { ...local, ...Object.fromEntries(Object.entries(managed).filter(([, v]) => v)) };
  cfg.apiUrl = (cfg.apiUrl || '').replace(/\/$/, '');
  cfg.scope = cfg.scope || (cfg.clientId ? `api://${cfg.clientId}/access_as_user` : '');
  cfg.managed = Object.keys(managed).length > 0;
  cfg.complete = !!(cfg.apiUrl && cfg.tenantId && cfg.clientId);
  return cfg;
}
