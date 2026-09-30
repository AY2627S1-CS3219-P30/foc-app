import { afterAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

// react-dom decides whether it can use the DOM when first imported, so the globals come first.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Slider } = await import("../src/components/Slider");
const { CreditSlider } = await import("../src/components/CreditSlider");

afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

async function render(node: React.ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.replaceChildren(container);
  await act(() => createRoot(container as unknown as Element).render(node));
  return {
    container,
    input: container.querySelector("input")!,
    output: container.querySelector("output")!,
  };
}

async function slide(input: Awaited<ReturnType<typeof render>>["input"], value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

describe("Slider", () => {
  it("reads out an uncontrolled value and follows it", async () => {
    const { input, output } = await render(<Slider defaultValue={4} min={1} max={10} />);
    expect(output.textContent).toBe("4");
    await slide(input, "7");
    expect(output.textContent).toBe("7");
  });

  it("reads out where an unset slider starts", async () => {
    const { input, output } = await render(<Slider min={1} max={30} />);
    expect(output.textContent).toBe(input.value);
  });

  it("reads out a controlled value", async () => {
    function Controlled() {
      const [value, setValue] = useState(3);
      return <Slider value={value} onChange={(e) => setValue(Number(e.target.value) * 2)} max={20} />;
    }
    const { input, output } = await render(<Controlled />);
    expect(output.textContent).toBe("3");
    await slide(input, "5");
    expect(output.textContent).toBe("10");
  });

  it("ties the readout to the input without announcing it twice", async () => {
    const { input, output } = await render(<Slider defaultValue={4} />);
    expect(input.id).not.toBe("");
    expect(output.getAttribute("for")).toBe(input.id);
    expect(output.getAttribute("aria-live")).toBe("off");
    expect(output.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps CreditSlider labelled, controlled and reporting numbers", async () => {
    const seen: number[] = [];
    const { container, input, output } = await render(
      <CreditSlider value={5} onChange={(n) => seen.push(n)} />,
    );
    expect(container.querySelector("label")!.getAttribute("for")).toBe(input.id);
    expect(output.textContent).toBe("5");
    await slide(input, "9");
    expect(seen).toEqual([9]);
  });
});
