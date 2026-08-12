import type { Store } from "./db.js";
import type { Channel, Contact, User } from "../types/user.js";

interface UserRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  subscribed_channels: string;
  contacts: string;
  locale: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  active: number;
}

function toUser(row: UserRow): User {
  const subscribedChannels = JSON.parse(row.subscribed_channels) as Channel[];
  const contacts = JSON.parse(row.contacts) as Contact[];
  return {
    id: row.id,
    name: row.name,
    location: { lat: row.lat, lon: row.lon },
    subscribedChannels,
    contacts,
    locale: row.locale,
    quietHoursStart: row.quiet_hours_start ?? undefined,
    quietHoursEnd: row.quiet_hours_end ?? undefined,
    active: row.active === 1,
  };
}

export function upsertUser(store: Store, user: User): void {
  store.exec(
    `INSERT INTO users (id, name, lat, lon, subscribed_channels, contacts, locale, quiet_hours_start, quiet_hours_end, active)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       lat=excluded.lat,
       lon=excluded.lon,
       subscribed_channels=excluded.subscribed_channels,
       contacts=excluded.contacts,
       locale=excluded.locale,
       quiet_hours_start=excluded.quiet_hours_start,
       quiet_hours_end=excluded.quiet_hours_end,
       active=excluded.active`,
    [
      user.id,
      user.name,
      user.location.lat,
      user.location.lon,
      JSON.stringify(user.subscribedChannels),
      JSON.stringify(user.contacts),
      user.locale,
      user.quietHoursStart ?? null,
      user.quietHoursEnd ?? null,
      user.active ? 1 : 0,
    ],
  );
}

export function getActiveUsers(store: Store): User[] {
  return store.all<User>(
    `SELECT * FROM users WHERE active = 1`,
    [],
    (r) => toUser(r as unknown as UserRow),
  );
}

export function getUser(store: Store, id: string): User | null {
  return store.first<User>(
    `SELECT * FROM users WHERE id = ?`,
    [id],
    (r) => toUser(r as unknown as UserRow),
  );
}
