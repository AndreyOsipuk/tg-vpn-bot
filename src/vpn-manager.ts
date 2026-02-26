import { config } from './config';
import { logger } from './logger';
import { sleep } from './helpers';
import type { ServerEnvConfig, XuiClientTraffic } from './types';

// Session cookies per server code
const sessions = new Map<string, string>();

// --- Helpers ---

function getServerConfig(serverCode: string): ServerEnvConfig {
  const srv = config.servers.find(s => s.code === serverCode);
  if (!srv) throw new Error(`Server config not found for code: ${serverCode}`);
  return srv;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15_000),
      });
      return response;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        logger.warn({ url, attempt, delay, error: lastError.message }, 'Fetch retry');
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// --- Auth ---

async function login(serverCode: string): Promise<string> {
  const srv = getServerConfig(serverCode);
  const url = `${srv.panelUrl}/login`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: srv.panelUsername,
      password: srv.panelPassword,
    }),
  });

  if (!res.ok) {
    throw new Error(`Login failed for ${serverCode}: ${res.status} ${res.statusText}`);
  }

  // Extract session cookie from Set-Cookie header
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`No session cookie returned for ${serverCode}`);
  }

  // Parse "3x-ui=xxx; Path=/; ..." -> "3x-ui=xxx"
  const cookie = setCookie.split(';')[0];
  sessions.set(serverCode, cookie);
  logger.debug({ serverCode }, '3X-UI login successful');
  return cookie;
}

async function ensureSession(serverCode: string): Promise<string> {
  let cookie = sessions.get(serverCode);
  if (!cookie) {
    cookie = await login(serverCode);
  }
  return cookie;
}

async function apiRequest(
  serverCode: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const srv = getServerConfig(serverCode);
  const url = `${srv.panelUrl}${path}`;
  let cookie = await ensureSession(serverCode);

  const doRequest = async (sessionCookie: string): Promise<Response> => {
    const options: RequestInit = {
      method,
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    return fetchWithRetry(url, options);
  };

  let res = await doRequest(cookie);

  // Re-login on 401
  if (res.status === 401) {
    logger.info({ serverCode }, 'Session expired, re-logging in');
    cookie = await login(serverCode);
    res = await doRequest(cookie);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`3X-UI API error [${serverCode}] ${method} ${path}: ${res.status} ${text}`);
  }

  const json = await res.json() as { success: boolean; msg?: string; obj?: unknown };

  if (!json.success) {
    throw new Error(`3X-UI API failed [${serverCode}] ${method} ${path}: ${json.msg || 'unknown error'}`);
  }

  return json.obj;
}

// --- Public API ---

export async function addClient(
  serverCode: string,
  uuid: string,
  email: string,
  limitIp: number,
  trafficBytes: number,
  expiryTimestampMs: number,
): Promise<void> {
  const srv = getServerConfig(serverCode);

  const clientSettings = {
    id: uuid,
    flow: 'xtls-rprx-vision',
    email,
    limitIp,
    totalGB: trafficBytes,
    expiryTime: expiryTimestampMs,
    enable: true,
    tgId: '',
    subId: '',
    reset: 0,
  };

  await apiRequest(serverCode, 'POST', '/panel/api/inbounds/addClient', {
    id: srv.inboundId,
    settings: JSON.stringify({ clients: [clientSettings] }),
  });

  logger.info({ serverCode, email, uuid }, 'Client added to 3X-UI');
}

export async function removeClient(serverCode: string, clientUuid: string): Promise<void> {
  const srv = getServerConfig(serverCode);
  await apiRequest(
    serverCode,
    'POST',
    `/panel/api/inbounds/${srv.inboundId}/delClient/${clientUuid}`,
  );
  logger.info({ serverCode, clientUuid }, 'Client removed from 3X-UI');
}

export async function getClientTraffic(serverCode: string, email: string): Promise<XuiClientTraffic> {
  const obj = await apiRequest(
    serverCode,
    'GET',
    `/panel/api/inbounds/getClientTraffics/${email}`,
  ) as { up: number; down: number } | null;

  if (!obj) {
    return { up: 0, down: 0, total: 0 };
  }

  return {
    up: obj.up || 0,
    down: obj.down || 0,
    total: (obj.up || 0) + (obj.down || 0),
  };
}

export async function resetClientTraffic(serverCode: string, email: string): Promise<void> {
  const srv = getServerConfig(serverCode);
  await apiRequest(
    serverCode,
    'POST',
    `/panel/api/inbounds/${srv.inboundId}/resetClientTraffic/${email}`,
  );
  logger.info({ serverCode, email }, 'Client traffic reset');
}

export function buildVlessLink(
  serverCode: string,
  uuid: string,
  label: string,
): string {
  const srv = getServerConfig(serverCode);
  const params = new URLSearchParams({
    type: 'tcp',
    security: 'reality',
    pbk: srv.publicKey,
    fp: 'chrome',
    sni: srv.sni,
    sid: srv.shortId,
    flow: 'xtls-rprx-vision',
  });
  return `vless://${uuid}@${srv.serverIp}:${srv.serverPort}?${params.toString()}#${encodeURIComponent(label)}`;
}

export async function healthCheck(serverCode: string): Promise<boolean> {
  try {
    const srv = getServerConfig(serverCode);
    const res = await fetchWithRetry(`${srv.panelUrl}/`, { method: 'GET' }, 2);
    return res.ok || res.status === 302; // 302 = redirect to login = panel is alive
  } catch {
    return false;
  }
}

export async function healthCheckAll(): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  await Promise.all(
    config.servers.map(async (srv) => {
      const ok = await healthCheck(srv.code);
      results.set(srv.code, ok);
    }),
  );
  return results;
}
