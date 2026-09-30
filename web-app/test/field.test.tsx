import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "../src/components/Field";
import { FormField } from "../src/components/FormField";
import { Input } from "../src/components/Input";
import { Select } from "../src/components/Select";
import { Slider } from "../src/components/Slider";
import { Textarea } from "../src/components/Textarea";

const { document } = new Window();

function render(node: React.ReactNode) {
  document.body.innerHTML = renderToStaticMarkup(node);
  const label = document.querySelector("label")!;
  const control = document.querySelector("input, select, textarea")!;
  return { label, control };
}

describe("Field", () => {
  it.each([
    ["Input", <Input key="i" />],
    ["Select", <Select key="s" />],
    ["Textarea", <Textarea key="t" />],
    ["Slider", <Slider key="r" value={3} readOnly />],
  ])("labels its %s", (_, control) => {
    const { label, control: el } = render(<Field label="Name">{control}</Field>);
    expect(el.id).not.toBe("");
    expect(label.htmlFor).toBe(el.id);
  });

  it("describes the control by its hint and error, and marks it invalid", () => {
    const { control } = render(
      <Field label="Email" hint="Your NUS address" error="Enter an NUS email">
        <Input />
      </Field>,
    );
    const ids = control.getAttribute("aria-describedby")!.split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Your NUS address",
      "Enter an NUS email",
    ]);
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  it("labels a FormField by the id its caller gives", () => {
    const { label, control } = render(<FormField label="Email" id="email" error="Enter an NUS email" />);
    expect(control.id).toBe("email");
    expect(label.htmlFor).toBe("email");
    expect(control.getAttribute("aria-describedby")).toBe("email-error");
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the label linked when the control sets its own id", () => {
    const { label, control } = render(
      <Field label="Email">
        <Input id="mine" />
      </Field>,
    );
    expect(label.htmlFor).toBe(control.id);
  });

  it("adds the control's own description to the hint and error", () => {
    const { control } = render(
      <Field label="Email" hint="Your NUS address" error="Enter an NUS email">
        <Input aria-describedby="extra" aria-invalid={false} />
      </Field>,
    );
    const ids = control.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(3);
    expect(ids).toContain("extra");
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  it("is valid and undescribed with no hint or error", () => {
    const { control } = render(
      <Field label="Email">
        <Input />
      </Field>,
    );
    expect(control.hasAttribute("aria-invalid")).toBe(false);
    expect(control.hasAttribute("aria-describedby")).toBe(false);
  });

  it("marks a required control and shows the marker to sighted users only", () => {
    const { label, control } = render(
      <Field label="Email" required>
        <Input />
      </Field>,
    );
    expect(control.hasAttribute("required")).toBe(true);
    expect(label.querySelector('[aria-hidden="true"]')?.textContent).toBe(" *");
  });

  it("lets a control outside a Field stand alone", () => {
    document.body.innerHTML = renderToStaticMarkup(<Input aria-label="Search" />);
    expect(document.querySelector("input")!.getAttribute("aria-label")).toBe("Search");
  });
});
