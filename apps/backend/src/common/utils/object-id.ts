const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Whether a string is a 24-hex-digit document id. */
export function isValidObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}
