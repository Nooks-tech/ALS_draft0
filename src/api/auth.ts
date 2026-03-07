/**
 * Auth API – phone-based SMS OTP
 */
import { api } from './client';

export interface VerifyOtpResponse {
  ok: boolean;
  session: {
    access_token: string;
    refresh_token: string;
  };
  user: {
    id: string;
    phone: string;
  };
}

export const authApi = {
  sendOtp: (phone: string) =>
    api.post<{ ok: boolean }>('/api/auth/send-otp', { phone }),

  verifyOtp: (phone: string, code: string) =>
    api.post<VerifyOtpResponse>('/api/auth/verify-otp', { phone, code }),
};
