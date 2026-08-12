import type { AffectedRegion, SeverityLevel } from "../types/events.js";
import type {
  LocationSubscription,
  NotificationPreferences,
  User,
} from "../types/user.js";
import {
  type LocationMatcher,
  type MatchResult,
  radiusBBoxMatcher,
} from "../services/locationMatcher.js";
import { resolveSubscriptions } from "../types/user.js";

const LEVEL_RANK: Record<SeverityLevel, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface AudienceMatch {
  user: User;
  /** Distance in km to the nearest subscribed location (radius subs only). */
  distanceKm?: number;
  /** Name of the subscription that matched (for logging). */
  matchedSubscription?: string;
}

/**
 * Determine which users should be alerted about a single event.
 *
 * The algorithm:
 *
 *   1. For each user, resolve their subscribed locations (legacy `location`
 *      gets hoisted to a single-radius subscription).
 *   2. Test whether the event's affected region overlaps any subscription
 *      via the pluggable {@link LocationMatcher}.
 *   3. Drop users whose severity threshold is below the event's severity.
 *   4. Return matches in stable order (preserves input order).
 *
 * When the event has no affected region, returns an empty list -- the agent
 * never sends to anyone without a positive geographic match.
 */
export function matchAudience(input: {
  event: {
    severity: { level: SeverityLevel };
    affectedRegion?: AffectedRegion;
  };
  users: ReadonlyArray<User>;
  matcher?: LocationMatcher;
}): AudienceMatch[] {
  const matcher = input.matcher ?? radiusBBoxMatcher;
  const eventSeverityRank = LEVEL_RANK[input.event.severity.level];
  const matches: AudienceMatch[] = [];

  for (const user of input.users) {
    const resolved = resolveSubscriptions(user);
    const prefRank = LEVEL_RANK[resolved.preferences.severityThreshold];

    // Severity gate -- events below the user's threshold are ignored.
    if (eventSeverityRank < prefRank) continue;

    const hit = firstSubscriptionHit(
      resolved.locations,
      input.event.affectedRegion,
      matcher,
    );
    if (!hit) continue;

    matches.push({
      user,
      distanceKm: hit.distanceKm,
      matchedSubscription: hit.subscriptionName,
    });
  }

  return matches;
}

/**
 * Convenience: just the users, no metadata. The agent + entrypoint only
 * need the user record to drive channel selection.
 */
export function filterUsersByRegion(input: {
  event: {
    severity: { level: SeverityLevel };
    affectedRegion?: AffectedRegion;
  };
  users: ReadonlyArray<User>;
  matcher?: LocationMatcher;
}): User[] {
  return matchAudience(input).map((m) => m.user);
}

/**
 * Test whether a single user is in the audience of a single event. Useful
 * for ad-hoc lookups and per-user routing decisions.
 */
export function isUserInAudience(input: {
  user: User;
  event: {
    severity: { level: SeverityLevel };
    affectedRegion?: AffectedRegion;
  };
  matcher?: LocationMatcher;
}): boolean {
  return filterUsersByRegion({
    event: input.event,
    users: [input.user],
    matcher: input.matcher,
  }).length > 0;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function firstSubscriptionHit(
  subs: LocationSubscription[],
  region: AffectedRegion | undefined,
  matcher: LocationMatcher,
): { distanceKm?: number; subscriptionName?: string } | null {
  if (!region || subs.length === 0) return null;

  for (const sub of subs) {
    // Subscription center must fall inside the event's affected region.
    const result: MatchResult = matcher.contains(region, sub.center);
    if (result.hit) {
      return {
        distanceKm: result.distanceKm,
        subscriptionName: sub.name,
      };
    }
  }
  return null;
}

/** Re-exported so callers can build their own gates (e.g. quiet hours). */
export { resolveSubscriptions };
export type { NotificationPreferences };