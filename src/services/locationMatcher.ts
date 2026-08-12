import type { AffectedRegion, GeoPoint } from "../types/events.js";

/**
 * A pluggable location matcher. The MVP implementation is in-memory
 * (haversine against a radius). Later this can be swapped for a real
 * geospatial database (PostGIS, BigQuery GIS, DuckDB spatial, etc.) by
 * implementing the same interface.
 */
export interface LocationMatcher {
  /**
   * Test whether a point falls inside a region. Returns the distance to the
   * nearest anchor in km when relevant, or undefined for bbox regions.
   */
  contains(region: AffectedRegion, point: GeoPoint): MatchResult;
}

export interface MatchResult {
  /** True if the point is inside the region. */
  hit: boolean;
  /** Distance in km to the nearest anchor (radius regions only). */
  distanceKm?: number;
}

/* -------------------------------------------------------------------------- */
/* Haversine distance                                                          */
/* -------------------------------------------------------------------------- */

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km between two geographic points. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/* -------------------------------------------------------------------------- */
/* In-memory MVP implementation                                                */
/* -------------------------------------------------------------------------- */

function pointInBBox(
  p: GeoPoint,
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number },
): boolean {
  return (
    p.lon >= bbox.minLon &&
    p.lon <= bbox.maxLon &&
    p.lat >= bbox.minLat &&
    p.lat <= bbox.maxLat
  );
}

/**
 * MVP matcher: radius + bbox regions, no spatial indexing. Fine for hundreds
 * of subscribers; swap for a proper spatial store when the count grows.
 */
export const radiusBBoxMatcher: LocationMatcher = {
  contains(region, point) {
    if (region.kind === "bbox") {
      return { hit: pointInBBox(point, region.bbox) };
    }
    const distanceKm = haversineKm(point, region.center);
    return { hit: distanceKm <= region.radiusKm, distanceKm };
  },
};

/**
 * Factory that accepts an injected matcher. Lets tests swap in a constant
 * matcher when they want to avoid haversine drift.
 */
export function makeLocationMatcher(
  matcher: LocationMatcher = radiusBBoxMatcher,
): LocationMatcher {
  return matcher;
}
