import { describe, expect, it } from "vitest";

import { makeProfile } from "../../testing/profileFactory";
import { type MenuItem, type RowMenuContext, buildRowMenu, requiresConfirmation } from "./rowMenu";

function context(overrides: Partial<RowMenuContext> = {}): RowMenuContext {
  return {
    profile: makeProfile(),
    running: false,
    trashed: false,
    selectionSize: 1,
    runningInSelection: 0,
    ...overrides,
  };
}

function find(items: MenuItem[], action: string): MenuItem | undefined {
  return items.find((item) => item.action === action);
}

describe("buildRowMenu, single row", () => {
  it("offers JSON cookie export only and keeps cookie import", () => {
    const cookies = find(buildRowMenu(context()), "cookies");
    expect(cookies?.children?.map((item) => item.action)).toEqual(["cookies-export-json", "cookies-import"]);
  });
  it("offers launch on a stopped profile and stop on a running one, never both", () => {
    const stopped = buildRowMenu(context());
    expect(find(stopped, "launch")).toBeDefined();
    expect(find(stopped, "stop")).toBeUndefined();

    const running = buildRowMenu(context({ running: true }));
    expect(find(running, "stop")).toBeDefined();
    expect(find(running, "launch")).toBeUndefined();
  });

  it("disables delete while the browser is live, and says why", () => {
    // Deleting here would pull the user-data directory out from under a running
    // Chromium, so the entry stays visible and explains itself rather than
    // vanishing and teaching nothing.
    const items = buildRowMenu(context({ running: true }));
    const remove = find(items, "delete");

    expect(remove).toBeDefined();
    expect(remove?.disabledReason).toMatch(/stop the profile first/i);
  });

  it("enables delete once the profile is stopped", () => {
    expect(find(buildRowMenu(context()), "delete")?.disabledReason).toBeUndefined();
  });

  it("flips the favourite entry to match the profile", () => {
    expect(find(buildRowMenu(context()), "favorite")?.label).toMatch(/add to favorites/i);

    const favourite = context({ profile: makeProfile({ favorite: true }) });
    expect(find(buildRowMenu(favourite), "unfavorite")?.label).toMatch(/remove from favorites/i);
  });

  it("marks exactly the destructive entry as dangerous", () => {
    const dangerous = buildRowMenu(context()).filter((item) => item.danger === true);

    expect(dangerous.map((item) => item.action)).toEqual(["delete"]);
  });
});

describe("buildRowMenu, trashed row", () => {
  it("offers only restore and permanent deletion", () => {
    const items = buildRowMenu(context({ trashed: true }));

    expect(items.map((item) => item.action)).toEqual(["restore", "purge"]);
  });

  it("never offers to launch something that is in the trash", () => {
    const items = buildRowMenu(context({ trashed: true, running: false }));

    expect(find(items, "launch")).toBeUndefined();
  });
});

describe("buildRowMenu, bulk selection", () => {
  it("switches to bulk entries once more than one row is selected", () => {
    const items = buildRowMenu(context({ selectionSize: 3 }));

    expect(items.every((item) => item.action.startsWith("bulk-"))).toBe(true);
  });

  it("counts the rows each action would hit", () => {
    const items = buildRowMenu(context({ selectionSize: 5, runningInSelection: 2 }));

    expect(find(items, "bulk-launch")?.label).toBe("Launch 3 profiles");
    expect(find(items, "bulk-stop")?.label).toBe("Stop 2 profiles");
    expect(find(items, "bulk-delete")?.label).toBe("Move 5 profiles to trash");
  });

  it("says profile, not profiles, for a count of one", () => {
    const items = buildRowMenu(context({ selectionSize: 2, runningInSelection: 1 }));

    expect(find(items, "bulk-launch")?.label).toBe("Launch 1 profile");
    expect(find(items, "bulk-stop")?.label).toBe("Stop 1 profile");
  });

  it("disables bulk launch when every selected profile already runs", () => {
    const items = buildRowMenu(context({ selectionSize: 3, runningInSelection: 3 }));

    expect(find(items, "bulk-launch")?.disabledReason).toMatch(/already running/i);
    expect(find(items, "bulk-stop")?.disabledReason).toBeUndefined();
  });

  it("disables bulk stop when none of them runs", () => {
    const items = buildRowMenu(context({ selectionSize: 3, runningInSelection: 0 }));

    expect(find(items, "bulk-stop")?.disabledReason).toMatch(/no selected profile is running/i);
  });

  it("blocks a bulk delete that would hit a live browser, naming the count", () => {
    const items = buildRowMenu(context({ selectionSize: 4, runningInSelection: 2 }));

    expect(find(items, "bulk-delete")?.disabledReason).toBe("Stop 2 running profiles first");
  });

  it("blocks a bulk delete over a single running profile with singular wording", () => {
    const items = buildRowMenu(context({ selectionSize: 4, runningInSelection: 1 }));

    expect(find(items, "bulk-delete")?.disabledReason).toBe("Stop 1 running profile first");
  });

  it("offers restore and purge for a bulk selection in the trash", () => {
    const items = buildRowMenu(context({ selectionSize: 3, trashed: true }));

    expect(items.map((item) => item.action)).toEqual(["bulk-restore", "bulk-purge"]);
    expect(find(items, "bulk-purge")?.label).toBe("Delete 3 profiles permanently");
  });
});

describe("menu shape", () => {
  const cases: RowMenuContext[] = [
    context(),
    context({ running: true }),
    context({ trashed: true }),
    context({ selectionSize: 3 }),
    context({ selectionSize: 3, runningInSelection: 3 }),
    context({ selectionSize: 3, trashed: true }),
  ];

  it("never produces an empty menu", () => {
    for (const each of cases) {
      expect(buildRowMenu(each).length).toBeGreaterThan(0);
    }
  });

  it("never repeats an action in one menu", () => {
    for (const each of cases) {
      const actions = buildRowMenu(each).map((item) => item.action);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it("gives every entry a non-empty label", () => {
    for (const each of cases) {
      for (const item of buildRowMenu(each)) {
        expect(item.label.trim().length, item.action).toBeGreaterThan(0);
      }
    }
  });

  it("never opens a menu with a separator", () => {
    for (const each of cases) {
      expect(buildRowMenu(each)[0].separatorBefore).not.toBe(true);
    }
  });

  it("puts every irreversible action behind a confirmation", () => {
    for (const each of cases) {
      for (const item of buildRowMenu(each)) {
        if (item.danger === true) {
          expect(requiresConfirmation(item.action), item.action).toBe(true);
        }
      }
    }
  });

  it("does not demand a confirmation for a reversible action", () => {
    // Confirming a launch trains the user to click through the delete dialog too.
    for (const action of ["launch", "stop", "open", "favorite", "restore"] as const) {
      expect(requiresConfirmation(action), action).toBe(false);
    }
  });
});
