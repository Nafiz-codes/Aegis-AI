import { z } from "zod";
import { GeoPoint } from "./events.js";

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

/** User/subscription record. */
export const User = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Anchor point — typically home/work location. */
  location: GeoPoint,
  /** Channels the user wants alerts on, in priority order. */
  subscribedChannels: z.array(Channel).min(1),
  /** Per-channel contact info; must include an entry for each subscribed channel. */
  contacts: z.array(Contact).min(1),
  /** Optional locale for translations. */
  locale: z.string().default("en"),
  /** Quiet hours in 24h local time (we still email during quiet hours). */
  quietHoursStart: z.number().int().min(0).max(24).optional(),
  quietHoursEnd: z.number().int().min(0).max(24).optional(),
  active: z.boolean().default(true),
});
export type User = z.infer<typeof User>;
