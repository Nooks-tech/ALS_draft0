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
  sendOtp: (phone: string, merchantId: string) =>
    api.post<{ ok: boolean }>('/api/auth/send-otp', {
      phone,
      merchantId,
    }),

  // Phase B: merchantId is now required so the server can scope the
  // OTP lookup AND stamp merchant_customers.verified_at for THIS
  // merchant only. deviceId is optional but recommended — when
  // present, the server will treat the verification as bound to this
  // device (groundwork for "re-OTP on a new device" tightening).
  verifyOtp: (
    phone: string,
    code: string,
    merchantId: string,
    deviceId?: string,
  ) =>
    api.post<VerifyOtpResponse>('/api/auth/verify-otp', {
      phone,
      code,
      merchantId,
      ...(deviceId ? { deviceId } : {}),
    }),
};
