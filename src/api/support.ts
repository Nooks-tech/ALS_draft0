import { api } from './client';

export function createSupportTicket(payload: {
  merchantId?: string | null;
  subject: string;
  message: string;
}) {
  return api.post<{ success: boolean; ticketId: string; createdAt: string }>('/api/support', payload);
}
