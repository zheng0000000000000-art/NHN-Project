import { readFile } from 'node:fs/promises';

// ntfy 발송기. 알림이 실패해도 부르는 쪽의 작업은 성공으로 둔다 —
// 알림이 안 갔다고 사람이 쓴 글을 잃으면 안 된다.
//
// 토픽을 여기에 적어두지 않는다. 정본은 Local-First 의 appsettings 하나이고
// 감시 스크립트도 같은 값을 읽는다. 두 벌로 두면 한쪽만 바뀌어 알림이 조용히 다른 데로 간다.
const DEFAULT_SETTINGS = 'C:\\Users\\1\\Documents\\Local-First Workflow Dashboard\\server\\appsettings.json';

let cached = null;

export async function resolveNtfyTarget({
  settingsPath = process.env.NTFY_SETTINGS || DEFAULT_SETTINGS,
  reload = false,
} = {}) {
  if (cached && !reload) return cached;
  const server = process.env.NTFY_SERVER || null;
  const topic = process.env.NTFY_TOPIC || null;
  if (server && topic) {
    cached = { server, topic, source: 'env' };
    return cached;
  }
  try {
    const config = JSON.parse(await readFile(settingsPath, 'utf8'));
    const ntfy = config?.Ntfy ?? {};
    if (!ntfy.Enabled || !ntfy.Topic) return null;
    cached = { server: server ?? ntfy.Server ?? 'https://ntfy.sh', topic: topic ?? ntfy.Topic, source: 'appsettings' };
    return cached;
  } catch {
    return null;
  }
}

// 보내고 성패를 돌려준다. 던지지 않는다.
export async function notifyText(title, body, options = {}) {
  const target = await resolveNtfyTarget(options);
  if (!target) return { sent: false, reason: 'ntfy-not-configured' };
  try {
    const response = await fetch(`${target.server}/${target.topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: '4', 'Content-Type': 'text/plain; charset=utf-8' },
      body,
    });
    return { sent: response.ok, reason: response.ok ? null : `http-${response.status}` };
  } catch (error) {
    return { sent: false, reason: `send-failed: ${error.message}` };
  }
}
