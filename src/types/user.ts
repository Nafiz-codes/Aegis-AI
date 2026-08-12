import { z } from "zod";
import { GeoPoint, SEVERITY_TIERS } from "./events.js";

/** Channels a user can subscribe to. */
export const Channel = z.enum(["email", "discord", "telegram"]);
export type Channel = z.infer<typeof Channel>;

/** Per-channel addressing + connection id once known. */
export const Contact = z.object({
  channel: Channel,
  /** Email address, Discord user id, or Telegram chat id. */
  address: z.string().min(1),
  /** Caspian connection id once the agent has connected the channel. */
  connectionId: z.string().optional(),
});
export type Contact = z.infer<typeof Contact>;

/**
 * One geographic area a user wants alerts for. MVP: a circular radius around
 * a known center (city centroid, postal code, etc.). The matcher is a
 * pluggable interface, so this shape can grow later (polygons, admin shapes).
 */
export const LocationSubscription = z.object({
  /** Human-readable label (e.g. "Dhaka", "Chattogram"). Used for logging. */
  name: z.string().min(1),
  /** Center point of the subscribed area. */
  center: GeoPoint,
  /** Radius around the center, in km. */
  radiusKm: z.number().positive().max(20_000),
});
export type LocationSubscription = z.infer<typeof LocationSubscription>;

/**
 * Per-user notification preferences. MVP shape.
 *
 *   - severityThreshold: minimum event tier we bother this user with.
 *     Events below the threshold are filtered out before they reach the agent.
 *   - quietHoursStart/End: local-time window during which we still email
 *     (always-on) but suppress push channels.
 */
export const NotificationPreferences = z.object({
  severityThreshold: z.enum(SEVERITY_TIERS).default("MODERATE"),
  quietHoursStart: z.number().int().min(0).max(24).optional(),
  quietHoursEnd: z.number().int().min(0).max(24).optional(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

/**
 * User/subscription record.
 *
 * A user subscribes to one or more geographic areas (e.g. their home city +
 * their workplace). Events whose affected region overlaps any of these areas
 * are routed to this user through their preferred channels.
 *
 * The legacy single-point `location` field is preserved as a single-radius
 * subscription of 50 km by the audience matcher, so older fixtures stay valid.
 */
export const User = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * @deprecated Use `subscribedLocations`. Kept so existing fixtures and
   * tests stay valid; treated as a single-radius subscription around this
   * point by the audience matcher.
   */
  location: GeoPoint.optional(),
  /** One or more geographic areas the user wants alerts for. */
  subscribedLocations: z.array(LocationSubscription).min(1).optional(),
  /** Channels the user wants alerts on, in priority order. */
  subscribedChannels: z.array(Channel).min(1),
  /** Per-channel contact info; must include an entry for each subscribed channel. */
  contacts: z.array(Contact).min(1),
  /** Notification preferences -- severity threshold + quiet hours. */
  preferences: NotificationPreferences.default({ severityThreshold: "MODERATE" }),
  /** Optional locale for translations. */
  locale: z.string().default("en"),
  active: z.boolean().default(true),
});
export type User = z.infer<typeof User>;

/**
 * Resolved view of a user used at match time. The matcher always sees this
 * shape, never the raw User, so the legacy `location` field can be hoisted
 * into `subscribedLocations` transparently.
 */
export interface ResolvedSubscriptions {
  userId: string;
  locations: LocationSubscription[];
  preferences: NotificationPreferences;
}
export function resolveSubscriptions(user: User): ResolvedSubscriptions {
  const subs: LocationSubscription[] =
    user.subscribedLocations && user.subscribedLocations.length > 0
      ? user.subscribedLocations
      : user.location
        ? [
            {
              name: "primary",
              center: user.location,
              radiusKm: 50,
            },
          ]
        : [];
  return {
    userId: user.id,
    locations: subs,
    preferences: user.preferences,
  };
}
