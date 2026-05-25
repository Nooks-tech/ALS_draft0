import { Car, Check, Clock } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PriceWithSymbol } from '../common/PriceWithSymbol';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface OrderProps {
  id: string;
  status: 'Placed' | 'Accepted' | 'Preparing' | 'Ready' | 'Out for delivery' | 'Delivered' | 'Cancelled' | 'On Hold';
  orderType?: 'delivery' | 'pickup' | 'drivethru';
  price: number;
  date: string;
  items: string;
  refundStatus?: string | null;
  /** customer_orders.foodics_order_id — the arrival ping has no
   * destination if the order never reached Foodics, so the button
   * stays hidden until this is set. */
  foodicsOrderId?: string | null;
  /** customer_orders.customer_arrived_at — set after the customer
   * taps "I've arrived". When present the button is replaced by a
   * "Notified at HH:MM" pill so they know the cashier was pinged. */
  customerArrivedAt?: string | null;
  /** Optional callback for the "I've arrived" button. Only used on
   * drivethru orders with foodicsOrderId set and not yet arrived. */
  onMarkArrived?: () => void;
  onPress?: () => void;
}

export const OrderCard = ({ id, status, orderType, price, date, items, refundStatus, foodicsOrderId, customerArrivedAt, onMarkArrived, onPress }: OrderProps) => {
  const { i18n } = useTranslation();
  const { primaryColor, menuCardColor, textColor } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';
  // Drivethru ("Receive from your car") follows the pickup lifecycle —
  // 3-step, ends in Received. Treat it as pickup for status display.
  const isPickupLike = orderType === 'pickup' || orderType === 'drivethru';
  // Normalize the legacy "Accepted" / "Ready" statuses into the 3-step
  // pickup / 4-step delivery lifecycles the rest of the app now uses.
  const displayStatus: OrderProps['status'] =
    status === 'Accepted' ? 'Preparing' :
    status === 'Ready' && isPickupLike ? 'Delivered' :
    status === 'Ready' && orderType === 'delivery' ? 'Preparing' :
    status;
  const statusLabel =
    displayStatus === 'Placed' ? (isArabic ? 'تم الإرسال' : 'Placed') :
    displayStatus === 'Preparing' ? (isArabic ? 'قيد التحضير' : 'Preparing') :
    displayStatus === 'Out for delivery' ? (isArabic ? 'خرج للتوصيل' : 'Out for delivery') :
    displayStatus === 'Delivered'
      ? isPickupLike
        ? (isArabic ? 'تم الاستلام' : 'Received')
        : (isArabic ? 'تم التوصيل' : 'Delivered')
      :
    displayStatus === 'Cancelled' ? (isArabic ? 'ملغي' : 'Cancelled') :
    displayStatus === 'On Hold' ? (isArabic ? 'قيد الانتظار' : 'On Hold') :
    displayStatus;

  const getStatusColor = () => {
    switch (displayStatus) {
      case 'Placed': return 'bg-slate-100 text-slate-700';
      case 'Preparing': return 'bg-yellow-100 text-yellow-700';
      case 'Out for delivery': return 'bg-blue-100 text-blue-700';
      case 'Delivered': return orderType === 'pickup' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600';
      case 'Cancelled': return 'bg-red-100 text-red-600';
      case 'On Hold': return 'bg-orange-100 text-orange-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const statusStyle = getStatusColor();
  const [bgClass, textClass] = statusStyle.split(' ');

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      className="p-4 mb-4 rounded-xl border border-gray-100 shadow-sm"
      style={{ backgroundColor: menuCardColor }}
    >
      <View className="flex-row justify-between items-center mb-3">
        <Text className="font-medium" style={{ color: textColor }}>{isArabic ? 'الطلب' : 'Order'} #{id}</Text>
        <View className="flex-row gap-1.5">
          <View className={`px-3 py-1 rounded-full ${bgClass}`}>
            <Text className={`text-xs font-bold ${textClass}`}>{statusLabel}</Text>
          </View>
          {(refundStatus === 'refunded' || refundStatus === 'voided') && (
            <View className="px-2 py-1 rounded-full bg-green-100">
              <Text className="text-xs font-bold text-green-700">{isArabic ? 'تم الاسترجاع' : 'Refunded'}</Text>
            </View>
          )}
          {refundStatus === 'refund_failed' && (
            <View className="px-2 py-1 rounded-full bg-red-100">
              <Text className="text-xs font-bold text-red-600">{isArabic ? 'فشل الاسترجاع' : 'Refund Failed'}</Text>
            </View>
          )}
          {refundStatus === 'pending_manual' && (
            <View className="px-2 py-1 rounded-full bg-amber-100">
              <Text className="text-xs font-bold text-amber-700">{isArabic ? 'الاسترجاع قيد المعالجة' : 'Refund Pending'}</Text>
            </View>
          )}
        </View>
      </View>

      <View className="flex-row items-center mb-3">
        <View className="p-3 rounded-lg me-3" style={{ backgroundColor: `${primaryColor}10` }}>
          <Clock size={20} color={primaryColor} />
        </View>
        <View className="flex-1">
          <Text className="font-bold text-base" style={{ color: textColor }} numberOfLines={1}>{items}</Text>
          <Text className="text-xs mt-1" style={{ color: textColor }}>{date}</Text>
        </View>
      </View>

      <View className="flex-row justify-between items-center pt-3 border-t border-gray-50">
        <PriceWithSymbol amount={price} iconSize={18} iconColor={textColor} textStyle={{ color: textColor, fontWeight: '700', fontSize: 18 }} />
        <TouchableOpacity onPress={onPress}>
          <Text className="font-bold text-sm" style={{ color: primaryColor }}>{isArabic ? 'عرض التفاصيل' : 'View Details'}</Text>
        </TouchableOpacity>
      </View>

      {/* Curbside arrival button. Conditions for showing:
            - orderType is drivethru (other types have no arrival flow)
            - foodicsOrderId is set (cashier device exists to ping)
            - customerArrivedAt is still null (haven't pinged yet)
            - order is mid-flight, not Cancelled/Delivered/On Hold
          When already arrived, render a green confirmation pill with
          the local-time stamp instead of the button, so the customer
          knows the cashier was actually notified.
          stopPropagation isn't needed on the inner Touchable because
          react-native's TouchableOpacity wrapping is non-bubbling. */}
      {orderType === 'drivethru' && (
        customerArrivedAt ? (
          <View
            className="mt-3 pt-3 border-t border-gray-50 flex-row items-center"
            style={{ gap: 8 }}
          >
            <View className="rounded-full px-3 py-1.5 flex-row items-center bg-green-100" style={{ gap: 6 }}>
              <Check size={14} color="#15803d" />
              <Text className="text-xs font-bold text-green-700">
                {isArabic
                  ? `تم إعلام المتجر · ${new Date(customerArrivedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
                  : `Notified · ${new Date(customerArrivedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`}
              </Text>
            </View>
          </View>
        ) : (
          foodicsOrderId && onMarkArrived && status !== 'Cancelled' && status !== 'Delivered' && status !== 'On Hold' && (
            <TouchableOpacity
              onPress={onMarkArrived}
              activeOpacity={0.85}
              className="mt-3 pt-3 border-t border-gray-50 flex-row items-center justify-center rounded-xl py-3"
              style={{ backgroundColor: `${primaryColor}15`, borderRadius: 12 }}
            >
              <Car size={18} color={primaryColor} />
              <Text className="font-bold text-sm ms-2" style={{ color: primaryColor }}>
                {isArabic ? 'وصلت — أعلم الكاشير' : "I've arrived — notify cashier"}
              </Text>
            </TouchableOpacity>
          )
        )
      )}
    </TouchableOpacity>
  );
};