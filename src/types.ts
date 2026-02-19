// --- Database row types ---

export interface Server {
  id: number;
  code: string;
  name: string;
  emoji: string;
  inbound_id: number;
  server_ip: string;
  server_port: number;
  public_key: string;
  short_id: string;
  sni: string;
  is_active: number;
  max_users: number;
  created_at: string;
}

export interface User {
  id: number;
  telegram_id: number;
  username: string;
  first_name: string;
  is_blocked: number;
  trial_used: number;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: number;
  telegram_id: number;
  server_id: number;
  client_uuid: string;
  client_email: string;
  tariff_id: TariffId;
  expires_at: string;
  max_devices: number;
  traffic_limit: number;
  traffic_used: number;
  is_active: number;
  created_at: string;
}

export interface Payment {
  id: number;
  telegram_id: number;
  tariff_id: TariffId;
  server_id: number;
  amount: number;
  currency: string;
  status: PaymentStatus;
  invoice_id: string | null;
  payload: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Alert {
  id: number;
  type: string;
  message: string;
  created_at: string;
}

// --- Enums / unions ---

export type PaymentStatus = 'pending' | 'completed' | 'expired' | 'refunded';
export type TariffId = 'trial' | 'week' | 'month' | 'quarter' | 'year';

// --- Config types ---

export interface ServerEnvConfig {
  code: string;
  name: string;
  emoji: string;
  panelUrl: string;
  panelUsername: string;
  panelPassword: string;
  inboundId: number;
  serverIp: string;
  serverPort: number;
  publicKey: string;
  shortId: string;
  sni: string;
  maxUsers: number;
}

export interface AppConfig {
  botToken: string;
  adminId: number;
  yoomoneyToken: string;
  yoomoneyWallet: string;
  logLevel: string;
  servers: ServerEnvConfig[];
}

// --- Tariff types ---

export interface Tariff {
  id: TariffId;
  label: string;
  price: number;
  days: number;
  minutes?: number;
  maxDevices: number;
}

// --- 3X-UI API types ---

export interface XuiClientTraffic {
  up: number;
  down: number;
  total: number;
}

// --- Subscription with joined server info (for display) ---

export interface SubscriptionWithServer extends Subscription {
  server_code: string;
  server_name: string;
  server_emoji: string;
  server_ip: string;
  server_port: number;
  public_key: string;
  short_id: string;
  sni: string;
}
