export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function sliceUtf16Safe(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }

  let end = maxLength;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function sliceForJsonBudget(
  value: string,
  maxSerializedChars: number,
  maxPlainChars: number = maxSerializedChars,
): string {
  if (maxSerializedChars < 2 || maxPlainChars <= 0) {
    return '';
  }

  const capped = sliceUtf16Safe(value, maxPlainChars);
  if (JSON.stringify(capped).length <= maxSerializedChars) {
    return capped;
  }

  let low = 0;
  let high = capped.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = sliceUtf16Safe(capped, mid);
    if (JSON.stringify(candidate).length <= maxSerializedChars) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return sliceUtf16Safe(capped, low);
}
