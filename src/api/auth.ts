/**
 * Auth API - send & verify email OTP
 */
import { api } from './client';

export const authApi = {
  sendOtp: (email: string) =>
    api.post<{ ok: boolean }>('/api/auth/send-otp', { email }),

  verifyOtp: (email: string, code: string) =>
    api.post<{ ok: boolean }>('/api/auth/verify-otp', { email, code }),
};
