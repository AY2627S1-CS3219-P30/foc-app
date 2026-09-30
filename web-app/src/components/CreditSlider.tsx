import { Field } from "./Field";
import { Slider } from "./Slider";

export function CreditSlider({
  value,
  onChange,
  min = 1,
  max = 30,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Field label="Credits" hint="How many credits will you offer for this errand?">
      <Slider min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}
