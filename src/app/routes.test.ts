import { describe, expect, it } from "vitest";

import { DEFAULT_ROUTE, type Route, parseRoute, primaryNavKeyForRoute, routeToHash } from "./routes";

describe("route parsing", () => {
  it.each([
    ["", DEFAULT_ROUTE],
    ["#", DEFAULT_ROUTE],
    ["#/", DEFAULT_ROUTE],
    ["#/profiles", { name: "profiles", view: "all", folderId: null }],
    ["#/profiles/favorites", { name: "profiles", view: "favorites", folderId: null }],
    ["#/profiles/running", { name: "profiles", view: "running", folderId: null }],
    ["#/profiles/trash", { name: "profiles", view: "trash", folderId: null }],
    ["#/profiles/new", { name: "profile-new" }],
    ["#/proxies", { name: "proxies" }],
    ["#/templates", { name: "templates" }],
    ["#/automation", { name: "automation" }],
    ["#/settings", { name: "settings", section: "appearance" }],
    ["#/settings/sync", { name: "settings", section: "sync" }],
  ] as [string, Route][])("parses %s", (hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected);
  });

  it("reads a profile id out of the profiles path", () => {
    expect(parseRoute("#/profiles/11111111-1111-1111-1111-111111111111")).toEqual({
      name: "profile",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it.each([
    "#/profiles/../../etc/passwd",
    "#/profiles/<script>alert(1)</script>",
    "#/profiles/id with spaces",
    "#/profiles/" + "x".repeat(200),
    "#/nonsense",
    "#/settings/../secrets",
  ])("falls back rather than passing %s through", (hash) => {
    // The hash is address-bar input. An id that fails the shape check must never
    // reach a component that would render or send it.
    const route = parseRoute(hash);
    expect(route).not.toHaveProperty("id");
    if (route.name === "settings") {
      expect(route.section).toBe("appearance");
    }
  });

  it("rejects a folder id that does not match the expected shape", () => {
    expect(parseRoute("#/profiles?folder=../../etc")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#/profiles?folder=abc-123")).toEqual({
      name: "profiles",
      view: "all",
      folderId: "abc-123",
    });
  });

  it.each([
    { name: "profiles", view: "all", folderId: null },
    { name: "profiles", view: "trash", folderId: null },
    { name: "profiles", view: "all", folderId: "work" },
    { name: "profile", id: "abc" },
    { name: "profile-new" },
    { name: "proxies" },
    { name: "templates" },
    { name: "automation" },
    { name: "settings", section: "sync" },
  ] as Route[])("round-trips %o through its hash", (route) => {
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });

  it("keeps every profile route under the profiles nav item", () => {
    expect(primaryNavKeyForRoute({ name: "profiles", view: "trash", folderId: null })).toBe("profiles");
    expect(primaryNavKeyForRoute({ name: "profile", id: "abc" })).toBe("profiles");
    expect(primaryNavKeyForRoute({ name: "profile-new" })).toBe("profiles");
    expect(primaryNavKeyForRoute({ name: "proxies" })).toBe("proxies");
  });
});
