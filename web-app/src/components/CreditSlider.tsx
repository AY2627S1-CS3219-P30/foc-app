// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-10-21
// Scope: Implementation for "request composer on the Order API" (WEB-00, WEB-01); also bug fixes.
// Author review: Patrick Thomas reviewed the implementation for correctness, ran it against the
//   test suite, and checked that it fits our service boundaries without fatal errors before
//   committing.

import { REWARD_MAX, REWARD_MIN } from "@/lib/composer";
import { Field } from "./Field";
import { Slider } from "./Slider";

export function CreditSlider({
  value,
  onChange,
  min = REWARD_MIN,
  max = REWARD_MAX,
  error,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  error?: string;
}) {
  return (
    <Field
      label="Credits"
      hint="How many credits will you offer for this errand?"
      error={error}
    >
      <Slider min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}
