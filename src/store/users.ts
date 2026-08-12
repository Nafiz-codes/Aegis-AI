import type { Store } from "./db.js";
import type {
  Channel,
  Contact,
  LocationSubscription,
  NotificationPreferences,
  User,
} from "../types/user.js";

interface UserRow {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  subscribed_locations: string | null;
  subscribed_channels: string;
  contacts: string;
  preferences: string;
  locale: string;
  active: number;
}

function toUser(row: UserRow): User {
  const subscribedChannels = JSON.parse(row.subscribed_channels) as Channel[];
  const contacts = JSON.parse(row.contacts) as Contact[];
  const prefs = JSON.parse(row.preferences) as NotificationPreferences;
  const subscribedLocations = row.subscribed_locations
    ? (JSON.parse(row.subscribed_locations) as LocationSubscription[])
    : undefined;
  const legacyLocation =
    row.lat !== null && row.lon !== null
      ? { lat: row.lat, lon: row.lon }
      : undefined;
  return {
    id: row.id,
    name: row.name,
    location: legacyLocation,
    subscribedLocations,
    subscribedChannels,
    contacts,
    preferences: prefs,
    locale: row.locale,
    active: row.active === 1,
  };
}

export function upsertUser(store: Store, user: User): void {
  // Legacy single-point location survives as the first subscription if no
  // explicit list was given. We store the explicit list as-is; an empty list
  // is impossible because the schema enforces `min(1)`.
  const hasExplicitSubs =
    user.subscribedLocations && user.subscribedLocations.length > 0;
  const legacyLat = hasExplicitSubs ? null : (user.location?.lat ?? null);
  const legacyLon = hasExplicitSubs ? null : (user.location?.lon ?? null);
  store.exec(
    `INSERT INTO users (id, name, lat, lon, subscribed_locations, subscribed_channels, contacts, preferences, locale, active)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       lat=excluded.lat,
       lon=excluded.lon,
       subscribed_locations=excluded.subscribed_locations,
       subscribed_channels=excluded.subscribed_channels,
       contacts=excluded.contacts,
       preferences=excluded.preferences,
       locale=excluded.locale,
       active=excluded.active`,
    [
      user.id,
      user.name,
      legacyLat,
      legacyLon,
      hasExplicitSubs ? JSON.stringify(user.subscribedLocations) : null,
      JSON.stringify(user.subscribedChannels),
      JSON.stringify(user.contacts),
      JSON.stringify(user.preferences),
      user.locale,
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
