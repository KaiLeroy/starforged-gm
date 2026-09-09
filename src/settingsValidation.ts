export type OptionalNumberResult = { value: number | null; error: string | null };

/** Parses the complete input, unlike parseFloat("1abc") which silently accepts the prefix. */
export function parseOptionalNumber(input: string, label: string, min: number, max: number): OptionalNumberResult {
  const trimmed = input.trim();
  if (!trimmed) return { value: null, error: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { value: null, error: `${label} must be a complete number from ${min} to ${max}.` };
  }
  return { value, error: null };
}

export function validateSamplingSettings(temperature: string, topP: string) {
  const parsedTemperature = parseOptionalNumber(temperature, 'Temperature', 0, 2);
  const parsedTopP = parseOptionalNumber(topP, 'Top P', 0, 1);
  return {
    temperature: parsedTemperature.value,
    topP: parsedTopP.value,
    error: parsedTemperature.error || parsedTopP.error,
  };
}
