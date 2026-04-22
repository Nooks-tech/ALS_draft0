import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const CART_TTL_MS = 12 * 60 * 60 * 1000;

const CART_REMINDER_DELAY_SECONDS = 60 * 60;

type ScheduleArgs = {
  reminderKey: string;
  brandName: string;
  itemCount: number;
  isArabic: boolean;
};

export async function cancelAbandonedCartReminder(reminderKey: string): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(reminderKey);
    if (id) {
      await Notifications.cancelScheduledNotificationAsync(id);
      await AsyncStorage.removeItem(reminderKey);
    }
  } catch {
    // Best-effort only.
  }
}

export async function scheduleAbandonedCartReminder({
  reminderKey,
  brandName,
  itemCount,
  isArabic,
}: ScheduleArgs): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    await cancelAbandonedCartReminder(reminderKey);

    const safeBrand = brandName.trim() || (isArabic ? 'متجرك' : 'your cart');
    const title = isArabic ? 'سلتك تستناك' : `Still hungry?`;
    const body = isArabic
      ? `عندك ${itemCount} ${itemCount === 1 ? 'منتج' : 'منتجات'} من ${safeBrand} لسّا في السلة. كمّل الطلب قبل ما تروح عليك بعد 12 ساعة.`
      : `${itemCount} item${itemCount === 1 ? '' : 's'} from ${safeBrand} ${itemCount === 1 ? "is" : "are"} still in your cart. Check out before it poofs in 12 hours.`;

    const trigger = {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: CART_REMINDER_DELAY_SECONDS,
      repeats: false,
      ...(Platform.OS === 'android' ? { channelId: 'marketing' } : {}),
    } as Notifications.NotificationTriggerInput;

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data: { kind: 'abandoned_cart' },
      },
      trigger,
    });

    await AsyncStorage.setItem(reminderKey, id);
  } catch {
    // Ignore if notifications are unavailable on this device/environment.
  }
}
