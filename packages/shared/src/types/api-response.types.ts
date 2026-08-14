export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
  timestamp: string;
}

export function ok<T>(data: T, message?: string): ApiResponse<T> {
  return { success: true, data, message, timestamp: new Date().toISOString() };
}

export function fail(message: string, errors?: string[]): ApiResponse<never> {
  return { success: false, message, errors, timestamp: new Date().toISOString() };
}
