import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsgsSource } from "../src/adapters/usgsSource.js";
import { DisasterType, severityFromScore } from "../src/types/events.js";

const goodFeature = {
  type: "Feature",
  id: "us7000abcd",
  properties: {
    mag: 5.4,
    place: "10km S of Somewhere, CA",
    time: Date.UTC(2025, 0, 1, 0, 0, 5),
    updated: Date.UTC(2025, 0, 1, 0, 0, 30),
    status: "reviewed",
    title: "M 5.4 - 10km S of Somewhere, CA",
    type: "earthquake",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000abcd.geojson",
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
  },
  geometry: { type: "Point", coordinates: [-118.0, 35.0, 5.0] },
  bbox: [-118.1, 34.9, -117.9, 35.1, 5, 5],
};

const makeFeed = (features: unknown[]) => ({
  type: "FeatureCollection",
  metadata: { generated: Date.now(), title: "USGS feed" },
  features,
});

const installFetchMock = (body: unknown, status = 200) => {
  const f = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad",
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", f);
  return f;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UsgsSource.fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T01:00:00.000Z"));
  });

  it("returns discovered events for well-formed features", async () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    installFetchMock(makeFeed([goodFeature]));
    const events = await src.fetch(Date.UTC(2024, 11, 31, 23, 0, 0));
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.externalId).toBe("us7000abcd");
    expect(e.sourceName).toBe("USGS Earthquake Hazards Program");
    expect(e.sourceUrl).toContain("eventpage/us7000abcd");
    expect(e.severityScore).toBeGreaterThan(0);
  });

  it("drops features with missing geometry", async () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    const bad = { ...goodFeature, geometry: null };
    installFetchMock(makeFeed([bad]));
    const events = await src.fetch(0);
    expect(events).toHaveLength(0);
  });

  it("drops features with bad coordinates", async () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    const bad = {
      ...goodFeature,
      geometry: { type: "Point", coordinates: [999, -999, 0] },
    };
    installFetchMock(makeFeed([bad]));
    const events = await src.fetch(0);
    expect(events).toHaveLength(0);
  });

  it("drops non-reviewed statuses", async () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    const bad = { ...goodFeature, properties: { ...goodFeature.properties, status: "automatic" } };
    installFetchMock(makeFeed([bad]));
    const events = await src.fetch(0);
    expect(events).toHaveLength(0);
  });

  it("drops features with no magnitude", async () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    const bad = {
      ...goodFeature,
      properties: { ...goodFeature.properties, mag: null },
    };
    installFetchMock(makeFeed([bad]));
    const events = await src.fetch(0);
    expect(events).toHaveLength(0);
  });

  it("supports a caller-supplied feedUrl", async () => {
    const custom = "https://example.test/feed.geojson";
    const fetchMock = installFetchMock(makeFeed([goodFeature]));
    const src = new UsgsSource(custom);
    await src.fetch(0);
    expect(fetchMock).toHaveBeenCalledWith(
      custom,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});

describe("UsgsSource.normalize", () => {
  it("produces a schema-valid NormalizedEvent", () => {
    const src = new UsgsSource("https://example.test/feed.geojson");
    installFetchMock(makeFeed([goodFeature]));
    return src.fetch(0).then((events) => {
      const norm = src.normalize(events[0]!);
      const parsed = DisasterType.parse(norm.type);
      expect(parsed).toBe("earthquake");
      expect(norm.id).toMatch(/^[0-9a-f]{16}$/);
      expect(norm.severity.level).toBeDefined();
      expect(severityFromScore(norm.severity.score).level).toBe(norm.severity.level);
      expect(norm.affectedRegion?.kind).toBe("radius");
      if (norm.affectedRegion?.kind === "radius") {
        expect(norm.affectedRegion.radiusKm).toBeGreaterThan(0);
      }
      expect(norm.sourceUrl).toContain("eventpage/us7000abcd");
    });
  });
});

describe("UsgsSource.validate", () => {
  const src = new UsgsSource("https://example.test/feed.geojson");
  it("accepts a normalized USGS event", () => {
    installFetchMock(makeFeed([goodFeature]));
    return src.fetch(0).then(([ev]) => {
      const norm = src.normalize(ev!);
      const result = src.validate(norm);
      expect(result.ok).toBe(true);
    });
  });
  it("rejects events from another source", () => {
    const result = src.validate({
      ...({} as any),
      source: "nws",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-source");
  });
});
