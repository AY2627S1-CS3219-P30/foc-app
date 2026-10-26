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
