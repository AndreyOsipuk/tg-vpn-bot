import 'dotenv/config';
import type { AppConfig, ServerEnvConfig } from './types';

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return val;
}

function requiredInt(key: string): number {
  const val = parseInt(required(key), 10);
  if (isNaN(val)) {
    throw new Error(`Env variable ${key} must be a number`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function parseServers(): ServerEnvConfig[] {
  const servers: ServerEnvConfig[] = [];

  // Scan env for VPN_*_PANEL_URL to discover server codes
  const codePattern = /^VPN_([A-Z]+)_PANEL_URL$/;
  for (const key of Object.keys(process.env)) {
    const match = key.match(codePattern);
    if (!match) continue;

    const code = match[1].toLowerCase();
    const prefix = `VPN_${match[1]}`;

    servers.push({
      code,
      name: required(`${prefix}_NAME`),
      emoji: required(`${prefix}_EMOJI`),
      panelUrl: required(`${prefix}_PANEL_URL`).replace(/\/$/, ''),
      panelUsername: required(`${prefix}_PANEL_USERNAME`),
      panelPassword: required(`${prefix}_PANEL_PASSWORD`),
      inboundId: requiredInt(`${prefix}_INBOUND_ID`),
      serverIp: required(`${prefix}_SERVER_IP`),
      serverPort: parseInt(optional(`${prefix}_SERVER_PORT`, '443'), 10),
      publicKey: required(`${prefix}_PUBLIC_KEY`),
      shortId: required(`${prefix}_SHORT_ID`),
      sni: required(`${prefix}_SNI`),
      maxUsers: parseInt(optional(`${prefix}_MAX_USERS`, '100'), 10),
    });
  }

  if (servers.length === 0) {
    throw new Error('No VPN servers configured. Add VPN_XX_PANEL_URL to .env');
  }

  return servers;
}

export const config: AppConfig = {
  botToken: required('BOT_TOKEN'),
  adminId: requiredInt('ADMIN_ID'),
  yoomoneyToken: required('YOOMONEY_TOKEN'),
  yoomoneyWallet: required('YOOMONEY_WALLET'),
  logLevel: optional('LOG_LEVEL', 'info'),
  servers: parseServers(),
};
