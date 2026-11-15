import { config } from '../config.js';
import { pollGraph } from './graph.js';
import { pollGmail } from './gmail.js';
import { pollImap } from './imap.js';

let running = false;
export async function pollOnce() {
  if (running) return;
  running = true;
  try {
    if (config.mail.inbound === 'gmail') await pollGmail();
    else if (config.mail.inbound === 'graph') await pollGraph();
    else if (config.mail.inbound === 'imap') await pollImap();
  } catch (e) {
    console.error('[mail] poll failed:', (e as Error).message);
  } finally {
    running = false;
  }
}

export function startMailPoller() {
  if (config.mail.inbound === 'none') {
    console.log('[mail] inbound email disabled (MAIL_INBOUND=none)');
    return;
  }
  console.log(`[mail] polling ${config.mail.address} via ${config.mail.inbound} every ${config.mail.pollSeconds}s`);
  void pollOnce();
  setInterval(pollOnce, config.mail.pollSeconds * 1000).unref();
}
