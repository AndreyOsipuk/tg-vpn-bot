import type { Tariff, TariffId } from './types';

const ruTariffs: Tariff[] = [
  { id: 'trial',   label: 'Попробовать (1 день)',                    price: 0,   days: 1,  maxDevices: 1 },
  { id: 'week',    label: '7 дней — 50 руб',                        price: 50,  days: 7,  maxDevices: 2 },
  { id: 'month',   label: '30 дней — 150 руб',                      price: 150, days: 30, maxDevices: 3 },
  { id: 'quarter', label: '90 дней — 400 руб',                      price: 400, days: 90, maxDevices: 3 },
  { id: 'year',    label: '1 год — 1200 руб (100 руб/мес)',         price: 1200, days: 365, maxDevices: 3 },
];

const nlTariffs: Tariff[] = [
  { id: 'trial',   label: 'Попробовать (1 день)',                    price: 0,   days: 1,  maxDevices: 1 },
  { id: 'week',    label: '7 дней — 80 руб',                        price: 80,  days: 7,  maxDevices: 2 },
  { id: 'month',   label: '30 дней — 250 руб',                      price: 250, days: 30, maxDevices: 3 },
  { id: 'quarter', label: '90 дней — 650 руб',                      price: 650, days: 90, maxDevices: 3 },
  { id: 'year',    label: '1 год — 2000 руб (167 руб/мес)',         price: 2000, days: 365, maxDevices: 3 },
];

const serverTariffs: Record<string, Tariff[]> = {
  ru: ruTariffs,
  nl: nlTariffs,
};

export function getServerTariffs(serverCode: string): Tariff[] | undefined {
  return serverTariffs[serverCode];
}

export function getTariff(serverCode: string, tariffId: TariffId): Tariff | undefined {
  const tariffs = serverTariffs[serverCode];
  if (!tariffs) return undefined;
  return tariffs.find(t => t.id === tariffId);
}

export function getAllServerCodes(): string[] {
  return Object.keys(serverTariffs);
}
