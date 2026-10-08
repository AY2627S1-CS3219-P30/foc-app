import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/lib/api-client";
import { createStepUp, createStepUpPrompt, STEP_UP_CANCELLED } from "../src/lib/step-up";

const stepUpRequired = () =>
  new ApiError(401, "STEP_UP_REQUIRED", "Re-enter your password to confirm this action.");

/** An action that asks for the password until `steppedUp()` says it was re-entered. */
function guarded() {
  let stepped = false;
  let calls = 0;
  return {
    action: async () => {
      calls++;
      if (!stepped) throw stepUpRequired();
      return "done";
    },
    stepUp: () => {
      stepped = true;
    },
    calls: () => calls,
  };
}

describe("password re-entry from the console", () => {
  it("runs an action that needs no password without asking", async () => {
    let asked = 0;
    const withStepUp = createStepUp(async () => (asked++, true));
    expect(await withStepUp(async () => "done")).toBe("done");
    expect(asked).toBe(0);
  });

  it("asks once, then runs the action again", async () => {
    const g = guarded();
    let asked = 0;
    const withStepUp = createStepUp(async () => {
      asked++;
      g.stepUp();
      return true;
    });
    expect(await withStepUp(g.action)).toBe("done");
    expect(asked).toBe(1);
    expect(g.calls()).toBe(2);
  });

  it("changes nothing when the prompt is cancelled", async () => {
    const g = guarded();
    const withStepUp = createStepUp(async () => false);
    const err = await withStepUp(g.action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(STEP_UP_CANCELLED);
    expect(g.calls()).toBe(1);
  });

  it("passes any other failure on without asking", async () => {
    let asked = 0;
    const withStepUp = createStepUp(async () => (asked++, true));
    const refused = new ApiError(403, "ADMIN_ACTION_NOT_PERMITTED", "Only a seeded administrator…");
    expect(
      await withStepUp(async () => {
        throw refused;
      }).catch((e: unknown) => e),
    ).toBe(refused);
    expect(asked).toBe(0);
  });

  it("retries only once: a second request for the password reaches the caller", async () => {
    let calls = 0;
    const withStepUp = createStepUp(async () => true);
    const err = await withStepUp(async () => {
      calls++;
      throw stepUpRequired();
    }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("STEP_UP_REQUIRED");
    expect(calls).toBe(2);
  });

  it("shows one prompt for actions that need it at the same time", async () => {
    const g = guarded();
    let asked = 0;
    let answer!: (ok: boolean) => void;
    const withStepUp = createStepUp(() => {
      asked++;
      return new Promise<boolean>((resolve) => (answer = resolve));
    });
    const both = Promise.all([withStepUp(g.action), withStepUp(g.action)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    g.stepUp();
    answer(true);
    expect(await both).toEqual(["done", "done"]);
    expect(asked).toBe(1);
  });
});

describe("the prompt store", () => {
  it("is asking from the first STEP_UP_REQUIRED until it is answered, and tells its listeners", async () => {
    const g = guarded();
    const prompt = createStepUpPrompt();
    const seen: boolean[] = [];
    const stop = prompt.subscribe(() => seen.push(prompt.isAsking()));

    const running = prompt.withStepUp(g.action);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt.isAsking()).toBe(true);

    g.stepUp();
    prompt.answer(true);
    expect(await running).toBe("done");
    expect(prompt.isAsking()).toBe(false);
    expect(seen).toEqual([true, false]);
    stop();
  });

  it("cancels the action when answered with false", async () => {
    const prompt = createStepUpPrompt();
    const running = prompt.withStepUp(guarded().action).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    prompt.answer(false);
    expect(((await running) as ApiError).code).toBe(STEP_UP_CANCELLED);
  });
});
