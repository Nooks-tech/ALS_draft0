import { useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, Camera, Flag, Map, MapPin, MessageSquare, Phone, RefreshCw, Store, Truck, User, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { useOrders } from '../src/context/OrdersContext';
import { useCart } from '../src/context/CartContext';
import { useAuth } from '../src/context/AuthContext';
import { OrderStatusStepper } from '../src/components/order/OrderStatusStepper';
import { OrderTrackingMap } from '../src/components/order/OrderTrackingMap';
import { otoApi, type OTOOrderStatusResponse } from '../src/api/oto';
import { submitComplaint, getOrderComplaint, customerMarkReceived, type ComplaintRow } from '../src/api/orders';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { supabase } from '../src/api/supabase';

const COMPLAINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STORE_COMPLAINT_TYPES = [
  { value: 'missing_item', label: 'Missing Item' },
  { value: 'wrong_item', label: 'Wrong Item' },
  { value: 'quality_issue', label: 'Quality Issue' },
] as const;

const FLEET_COMPLAINT_TYPES = [
  { value: 'damaged_packaging', label: 'Damaged Packaging' },
  { value: 'late_delivery', label: 'Late Delivery' },
  { value: 'tampered', label: 'Tampered / Opened' },
] as const;

const OTHER_COMPLAINT_TYPES = [
  { value: 'other', label: 'Other' },
] as const;

const ALL_COMPLAINT_TYPE_VALUES = [
  ...STORE_COMPLAINT_TYPES,
  ...FLEET_COMPLAINT_TYPES,
  ...OTHER_COMPLAINT_TYPES,
] as const;

type ComplaintTypeValue = (typeof ALL_COMPLAINT_TYPE_VALUES)[number]['value'];

const COMPLAINT_TYPE_ARABIC: Record<ComplaintTypeValue, string> = {
  missing_item: 'عنصر مفقود',
  wrong_item: 'عنصر خاطئ',
  quality_issue: 'مشكلة في الجودة',
  damaged_packaging: 'تغليف تالف',
  late_delivery: 'تأخر التوصيل',
  tampered: 'تم العبث / فتح الطلب',
  other: 'أخرى',
};

const STATUS_ARABIC: Record<string, string> = {
  Preparing: 'قيد التحضير',
  Ready: 'جاهز',
  'Out for delivery': 'خرج للتوصيل',
  Delivered: 'تم التوصيل',
  Cancelled: 'ملغي',
  'On Hold': 'قيد الانتظار',
};

export default function OrderDetailModal() {
  const { i18n } = useTranslation();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const { orders } = useOrders();
  const { setCartFromOrder } = useCart();
  const { user } = useAuth();
  const order = orders.find((o) => o.id === orderId);
  const { primaryColor } = useMerchantBranding();
  const [otoStatus, setOtoStatus] = useState<OTOOrderStatusResponse | null>(null);
  const driverPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Complaint state
  const [showComplaintModal, setShowComplaintModal] = useState(false);
  const [complaintType, setComplaintType] = useState<string>('missing_item');
  const [complaintDescription, setComplaintDescription] = useState('');
  const [complaintPhotos, setComplaintPhotos] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [submittingComplaint, setSubmittingComplaint] = useState(false);
  const [existingComplaint, setExistingComplaint] = useState<ComplaintRow | null>(null);
  const [loadingComplaint, setLoadingComplaint] = useState(false);
  const isArabic = i18n.language === 'ar';

  // Load existing complaint for delivered orders
  useEffect(() => {
    if (!orderId || order?.status !== 'Delivered') return;
    setLoadingComplaint(true);
    getOrderComplaint(orderId).then((c) => {
      setExistingComplaint(c);
      setLoadingComplaint(false);
    }).catch(() => setLoadingComplaint(false));
  }, [orderId, order?.status]);

  // "Mark received" fallback for pickup orders where the cashier never
  // closed the ticket. We unlock the button 45 minutes after ready_at.
  const CUSTOMER_RECEIVED_UNLOCK_MS = 45 * 60 * 1000;
  const [markReceivedLoading, setMarkReceivedLoading] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (order?.status !== 'Ready' || order.orderType !== 'pickup') return;
    const t = setInterval(() => setNowTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, [order?.status, order?.orderType]);
  const readyAtMs = order?.readyAt ? Date.parse(order.readyAt) : null;
  const receivedUnlockRemainingMs =
    readyAtMs != null && Number.isFinite(readyAtMs)
      ? Math.max(0, CUSTOMER_RECEIVED_UNLOCK_MS - (nowTick - readyAtMs))
      : CUSTOMER_RECEIVED_UNLOCK_MS;
  const showMarkReceived = order?.status === 'Ready' && order.orderType === 'pickup';
  const canMarkReceived = showMarkReceived && receivedUnlockRemainingMs <= 0;

  const handleMarkReceived = async () => {
    if (!orderId || markReceivedLoading) return;
    setMarkReceivedLoading(true);
    try {
      const result = await customerMarkReceived(String(orderId));
      if (!result.success) {
        Alert.alert(
          isArabic ? 'خطأ' : 'Error',
          result.error || (isArabic ? 'لم نستطع تحديث الطلب' : 'Could not update order'),
        );
      }
    } catch (e: any) {
      Alert.alert(isArabic ? 'خطأ' : 'Error', e?.message || 'Network error');
    } finally {
      setMarkReceivedLoading(false);
    }
  };

  // OTO polling
  useEffect(() => {
    if (!order?.otoId) return;
    let cancelled = false;
    const poll = () => {
      otoApi.getOrderStatus(order.otoId!).then((data) => {
        if (!cancelled) setOtoStatus(data);
      }).catch(() => {});
    };
    poll();
    if (order.status === 'Out for delivery') {
      driverPollRef.current = setInterval(poll, 10000);
    }
    return () => {
      cancelled = true;
      if (driverPollRef.current) clearInterval(driverPollRef.current);
    };
  }, [order?.otoId, order?.status]);

  const handleReorder = useCallback(() => {
    if (!order) return;
    setCartFromOrder({
      items: order.items,
      orderType: order.orderType,
      branchId: order.branchId,
      branchName: order.branchName,
      deliveryAddress: order.deliveryAddress,
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
    });
    router.back();
    router.replace('/(tabs)/menu');
  }, [order, setCartFromOrder, router]);

  const uploadPhoto = async (uri: string) => {
    if (!supabase) return;
    try {
      const ext = uri.split('.').pop()?.split('?')[0] || 'jpg';
      const fileName = `${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const formData = new FormData();
      formData.append('', {
        uri,
        name: fileName.split('/').pop(),
        type: `image/${ext}`,
      } as any);
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const session = (await supabase.auth.getSession()).data.session;
      const token = session?.access_token;
      const uploadRes = await fetch(
        `${supabaseUrl}/storage/v1/object/complaint-photos/${fileName}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-upsert': 'true',
          },
          body: formData,
        }
      );
      if (uploadRes.ok) {
        const { data: urlData } = supabase.storage.from('complaint-photos').getPublicUrl(fileName);
        if (urlData?.publicUrl) {
          setComplaintPhotos((prev) => [...prev, urlData.publicUrl]);
        }
      }
    } catch (err) {
      console.warn('[Complaint] Photo upload failed:', err);
    }
  };

  const handlePickPhoto = () => {
    if (complaintPhotos.length >= 3) return;
    Alert.alert(isArabic ? 'إضافة صورة' : 'Add Photo', isArabic ? 'اختر المصدر' : 'Choose a source', [
      {
        text: isArabic ? 'التقاط صورة' : 'Take Photo',
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            Alert.alert(isArabic ? 'الإذن مطلوب' : 'Permission Required', isArabic ? 'مطلوب إذن الكاميرا لالتقاط الصور.' : 'Camera access is needed to take photos.');
            return;
          }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
          if (!result.canceled && result.assets[0]) {
            await uploadPhoto(result.assets[0].uri);
          }
        },
      },
      {
        text: isArabic ? 'الاختيار من الصور' : 'Choose from Library',
        onPress: async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.7,
            allowsMultipleSelection: true,
            selectionLimit: 3 - complaintPhotos.length,
          });
          if (result.canceled) return;
          for (const asset of result.assets) {
            if (complaintPhotos.length >= 3) break;
            await uploadPhoto(asset.uri);
          }
        },
      },
      { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
    ]);
  };

  const handleSubmitComplaint = async () => {
    if (!orderId || !user?.id) return;
    setSubmittingComplaint(true);
    const affectedItems = order?.items
      .filter((item) => selectedItems[item.uniqueId])
      .map((item) => ({ item_name: item.name, quantity: item.quantity, price: item.price })) ?? [];

    try {
      const result = await submitComplaint(orderId, {
        complaint_type: complaintType as any,
        description: complaintDescription || undefined,
        photo_urls: complaintPhotos.length > 0 ? complaintPhotos : undefined,
        items: affectedItems.length > 0 ? affectedItems : undefined,
        customer_id: user.id,
      });
      if (result.success) {
        setShowComplaintModal(false);
        setExistingComplaint(result.complaint ?? null);
        Alert.alert(isArabic ? 'تم إرسال الشكوى' : 'Complaint Submitted', isArabic ? 'سيقوم المتجر بمراجعة شكواك قريباً.' : 'The merchant will review your complaint shortly.');
      } else {
        Alert.alert(isArabic ? 'خطأ' : 'Error', result.error || (isArabic ? 'تعذر إرسال الشكوى' : 'Failed to submit complaint'));
      }
    } catch (e: any) {
      Alert.alert(isArabic ? 'خطأ' : 'Error', e?.message || (isArabic ? 'تعذر إرسال الشكوى' : 'Failed to submit complaint'));
    }
    setSubmittingComplaint(false);
  };

  if (!order) {
    return (
      <View className="flex-1 justify-center items-center bg-black/60">
        <View className="bg-white rounded-2xl p-6 max-w-sm">
          <Text className="text-slate-600 text-center">{isArabic ? 'لم يتم العثور على الطلب' : 'Order not found'}</Text>
          <TouchableOpacity onPress={() => router.back()} className="mt-4 py-3 rounded-xl" style={{ backgroundColor: primaryColor }}>
            <Text className="text-white font-bold text-center">{isArabic ? 'إغلاق' : 'Close'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const branchLat = order.branchLat;
  const branchLon = order.branchLon;
  const isOutForDelivery = order.status === 'Out for delivery';
  const showDriverMap = isOutForDelivery && order.orderType === 'delivery' && branchLat != null && branchLon != null;
  const canShowMap = branchLat != null && branchLon != null;

  const isDelivered = order.status === 'Delivered';
  const deliveredAt = order.createdAt ? new Date(order.createdAt).getTime() : 0;
  const canReportIssue = isDelivered && (Date.now() - deliveredAt < COMPLAINT_WINDOW_MS) && !existingComplaint;

  const statusBadgeColors: Record<string, { bg: string; text: string }> = {
    Preparing: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
    Ready: { bg: 'bg-green-100', text: 'text-green-700' },
    'Out for delivery': { bg: 'bg-blue-100', text: 'text-blue-700' },
    Delivered: { bg: 'bg-gray-100', text: 'text-gray-600' },
    Cancelled: { bg: 'bg-red-100', text: 'text-red-600' },
    'On Hold': { bg: 'bg-orange-100', text: 'text-orange-600' },
  };
  const badge = statusBadgeColors[order.status] ?? { bg: 'bg-slate-100', text: 'text-slate-600' };

  // Refund/complaint status badges
  const refundBadge = (() => {
    if (order.refundStatus === 'refunded' || order.refundStatus === 'voided')
      return { label: isArabic ? 'تم الاسترجاع' : 'Refunded', bg: 'bg-green-100', text: 'text-green-700' };
    if (order.refundStatus === 'refund_failed')
      return { label: isArabic ? 'فشل الاسترجاع' : 'Refund Failed', bg: 'bg-red-100', text: 'text-red-600' };
    if (order.refundStatus === 'pending_manual')
      return { label: isArabic ? 'الاسترجاع قيد المعالجة' : 'Refund Pending', bg: 'bg-amber-100', text: 'text-amber-700' };
    return null;
  })();

  const complaintBadge = (() => {
    if (!existingComplaint) return null;
    if (existingComplaint.status === 'refunded')
      return { label: isArabic ? 'تمت الموافقة على الشكوى' : 'Complaint Approved', bg: 'bg-green-100', text: 'text-green-700' };
    if (existingComplaint.status === 'approved')
      return { label: isArabic ? 'الاسترجاع قيد التنفيذ' : 'Refund Processing', bg: 'bg-amber-100', text: 'text-amber-700' };
    if (existingComplaint.status === 'rejected')
      return { label: isArabic ? 'تم رفض الشكوى' : 'Complaint Rejected', bg: 'bg-red-100', text: 'text-red-600' };
    if (existingComplaint.status === 'pending')
      return { label: isArabic ? 'الشكوى قيد المراجعة' : 'Complaint Pending', bg: 'bg-orange-100', text: 'text-orange-600' };
    return null;
  })();

  const statusLabel = isArabic ? (STATUS_ARABIC[order.status] || order.status) : order.status;

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'الطلب' : 'Order'} #{order.id.replace('order-', '')}</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-4" showsVerticalScrollIndicator={false}>
          {/* Status + refund badges */}
          <View className="mb-4">
            <View className="flex-row flex-wrap gap-2">
              <View className={`self-start px-3 py-1 rounded-full ${badge.bg}`}>
                <Text className={`text-xs font-bold ${badge.text}`}>{statusLabel}</Text>
              </View>
              {refundBadge && (
                <View className={`self-start px-3 py-1 rounded-full ${refundBadge.bg}`}>
                  <Text className={`text-xs font-bold ${refundBadge.text}`}>{refundBadge.label}</Text>
                </View>
              )}
              {complaintBadge && (
                <View className={`self-start px-3 py-1 rounded-full ${complaintBadge.bg}`}>
                  <Text className={`text-xs font-bold ${complaintBadge.text}`}>{complaintBadge.label}</Text>
                </View>
              )}
            </View>
            <Text className="text-slate-500 text-sm mt-2">{order.date}</Text>
          </View>

          {/* Cancellation reason */}
          {order.status === 'Cancelled' && order.cancellationReason && (
            <View className="mb-4 p-4 bg-red-50 rounded-xl flex-row items-start">
              <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-red-700 text-sm">
                  {order.cancelledBy === 'merchant' ? (isArabic ? 'تم إلغاء الطلب من المتجر' : 'Cancelled by store') : order.cancelledBy === 'system' ? (isArabic ? 'تم إلغاء الطلب من النظام' : 'Cancelled by system') : (isArabic ? 'لقد قمت بإلغاء هذا الطلب' : 'You cancelled this order')}
                </Text>
                <Text className="text-red-600 text-sm mt-1">{order.cancellationReason}</Text>
                {(order.refundStatus === 'refunded' || order.refundStatus === 'voided') && (
                  <View className="flex-row flex-wrap items-center mt-1">
                    <Text className="text-green-600 text-xs font-medium">{isArabic ? 'تمت معالجة استرجاع بقيمة ' : 'Refund of '}</Text>
                    <PriceWithSymbol amount={order.refundAmount ?? order.total} iconSize={12} iconColor="#16a34a" textStyle={{ color: '#16a34a', fontSize: 12 }} />
                    <Text className="text-green-600 text-xs font-medium">{order.refundMethod === 'void' ? (isArabic ? ' (إلغاء بدون رسوم)' : ' processed (voided - no fee)') : (isArabic ? '' : ' processed')}</Text>
                  </View>
                )}
                {order.refundStatus === 'pending_manual' && (
                  <Text className="text-amber-600 text-xs mt-1 font-medium">{isArabic ? 'الاسترجاع قيد المعالجة' : 'Refund being processed'}</Text>
                )}
                {order.refundStatus === 'refund_failed' && (
                  <Text className="text-red-600 text-xs mt-1 font-medium">{isArabic ? 'فشل الاسترجاع - يرجى التواصل مع الدعم' : 'Refund failed - please contact support'}</Text>
                )}
              </View>
            </View>
          )}

          {/* OTO dispatch failure */}
          {order.orderType === 'delivery' && order.otoDispatchStatus === 'failed' && (
            <View className="mb-4 p-4 bg-amber-50 rounded-xl flex-row items-start">
              <AlertTriangle size={18} color="#D97706" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-amber-700 text-sm">{isArabic ? 'إرسال التوصيل قيد الانتظار' : 'Delivery dispatch pending'}</Text>
                <Text className="text-amber-700 text-sm mt-1">
                  {isArabic ? 'تعذر إرسال هذا الطلب إلى مزود التوصيل حتى الآن. المتجر لديه طلبك ويمكنه إعادة محاولة الإرسال.' : 'We could not send this order to the delivery provider yet. The store has your order and can retry dispatch.'}
                </Text>
                {!!order.otoDispatchError && (
                  <Text className="text-amber-800 text-xs mt-2">{isArabic ? 'التفاصيل' : 'Details'}: {order.otoDispatchError}</Text>
                )}
              </View>
            </View>
          )}

          {/* Existing complaint info */}
          {existingComplaint && (
            <View className="mb-4 p-4 bg-slate-50 rounded-xl flex-row items-start">
              <Flag size={18} color="#6366F1" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-slate-700 text-sm">{isArabic ? 'تم تقديم شكوى' : 'Complaint Filed'}</Text>
                <Text className="text-slate-600 text-sm mt-1 capitalize">{isArabic ? (COMPLAINT_TYPE_ARABIC[existingComplaint.complaint_type as keyof typeof COMPLAINT_TYPE_ARABIC] || existingComplaint.complaint_type) : existingComplaint.complaint_type.replace('_', ' ')}</Text>
                {existingComplaint.status === 'refunded' && existingComplaint.approved_refund_amount && (
                  <View className="flex-row flex-wrap items-center mt-1">
                    <Text className="text-green-600 text-xs font-medium">{isArabic ? 'تمت الموافقة على استرجاع بقيمة ' : 'Refund of '}</Text>
                    <PriceWithSymbol amount={existingComplaint.approved_refund_amount} iconSize={12} iconColor="#16a34a" textStyle={{ color: '#16a34a', fontSize: 12 }} />
                    <Text className="text-green-600 text-xs font-medium">{isArabic ? '' : ' approved'}</Text>
                  </View>
                )}
                {existingComplaint.status === 'rejected' && existingComplaint.merchant_notes && (
                  <Text className="text-red-600 text-xs mt-1">{existingComplaint.merchant_notes}</Text>
                )}
                {existingComplaint.status === 'pending' && (
                  <Text className="text-amber-600 text-xs mt-1 font-medium">{isArabic ? 'بانتظار مراجعة المتجر' : 'Awaiting merchant review'}</Text>
                )}
              </View>
            </View>
          )}

          {order.status !== 'Cancelled' && order.status !== 'On Hold' && (
            <View className="mb-6">
              <Text className="font-bold text-slate-800 mb-3">{isArabic ? 'حالة الطلب' : 'Order status'}</Text>
              <OrderStatusStepper status={order.status as any} orderType={order.orderType} accentColor={primaryColor} />
            </View>
          )}

          {showMarkReceived && (
            <View className="mb-6 p-4 rounded-2xl bg-slate-50 border border-slate-100">
              <Text className="text-slate-700 text-sm mb-3" style={{ textAlign: isArabic ? 'right' : 'left' }}>
                {canMarkReceived
                  ? (isArabic
                      ? 'إذا استلمت طلبك ولم يقم الكاشير بتأكيد الاستلام، يمكنك تأكيده بنفسك.'
                      : 'If you already picked up your order and the cashier forgot to confirm it, you can mark it yourself.')
                  : (isArabic
                      ? `يمكنك تأكيد استلام الطلب بعد ٤٥ دقيقة من جاهزيته. متبقي ${Math.ceil(receivedUnlockRemainingMs / 60000)} دقيقة.`
                      : `You can confirm receipt 45 minutes after the order was marked ready. ${Math.ceil(receivedUnlockRemainingMs / 60000)} min remaining.`)}
              </Text>
              <TouchableOpacity
                onPress={handleMarkReceived}
                disabled={!canMarkReceived || markReceivedLoading}
                className={`p-3 rounded-xl items-center ${canMarkReceived ? '' : 'opacity-50'}`}
                style={{ backgroundColor: canMarkReceived ? primaryColor : '#cbd5e1' }}
                activeOpacity={0.8}
              >
                {markReceivedLoading ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-bold">
                    {isArabic ? 'تأكيد استلام الطلب' : 'Mark as received'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {order.orderType === 'delivery' && order.deliveryAddress && (
            <View className="flex-row items-start mb-4 p-3 bg-slate-50 rounded-xl">
              <MapPin size={18} color={primaryColor} style={{ marginTop: 2 }} />
              <Text className="flex-1 ml-2 text-slate-700">{order.deliveryAddress}</Text>
            </View>
          )}
          {order.orderType === 'pickup' && order.branchName && (
            <View className="flex-row items-start mb-4 p-3 bg-slate-50 rounded-xl">
              <Store size={18} color="#F59E0B" style={{ marginTop: 2 }} />
              <Text className="flex-1 ml-2 text-slate-700">{order.branchName}</Text>
            </View>
          )}

          {/* Live driver tracking map */}
          {showDriverMap && (
            <View className="mb-6">
              <View className="flex-row items-center gap-2 mb-3">
                <Truck size={18} color={primaryColor} />
                <Text className="font-bold text-slate-800">{isArabic ? 'تتبع السائق المباشر' : 'Live driver tracking'}</Text>
              </View>
              <OrderTrackingMap
                branchLat={branchLat}
                branchLon={branchLon}
                deliveryLat={order.deliveryLat}
                deliveryLng={order.deliveryLng}
                driverLat={otoStatus?.driverLat}
                driverLon={otoStatus?.driverLon}
                branchName={order.branchName}
                accentColor={primaryColor}
                etaLabel={otoStatus?.estimatedDeliveryTime ?? null}
              />
              <View className="flex-row flex-wrap gap-2 mt-2">
                <View className="flex-row items-center gap-1.5">
                  <View className="w-2 h-2 rounded-full bg-amber-500" />
                  <Text className="text-slate-500 text-xs">{isArabic ? 'الفرع' : 'Branch'}</Text>
                </View>
                {(order.deliveryLat != null && order.deliveryLng != null) && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full" style={{ backgroundColor: primaryColor }} />
                    <Text className="text-slate-500 text-xs">{isArabic ? 'موقعك' : 'Your location'}</Text>
                  </View>
                )}
                {otoStatus?.driverLat != null && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full bg-indigo-500" />
                    <Text className="text-slate-500 text-xs">{isArabic ? 'السائق' : 'Driver'}</Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* Driver info card */}
          {order.driver_name && (order.status === 'Out for delivery' || order.status === 'Delivered') && (
            <View className="mx-0 mb-4 rounded-2xl border border-slate-100 bg-white p-4">
              <View className="flex-row items-center">
                <View className="w-10 h-10 rounded-full bg-slate-100 items-center justify-center mr-3">
                  <User size={20} color="#64748b" />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold text-slate-800">{order.driver_name}</Text>
                  {order.driver_phone ? (
                    <TouchableOpacity onPress={() => Linking.openURL(`tel:${order.driver_phone}`)}>
                      <View className="flex-row items-center mt-0.5">
                        <Phone size={13} color={primaryColor} />
                        <Text style={{ color: primaryColor }} className="text-sm ml-1">{order.driver_phone}</Text>
                      </View>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            </View>
          )}

          {/* Static map for non-delivery-tracking orders */}
          {canShowMap && !showDriverMap && order.status !== 'Cancelled' && (
            <View className="mb-6">
              <View className="flex-row items-center gap-2 mb-3">
                <Map size={18} color={primaryColor} />
                <Text className="font-bold text-slate-800">{isArabic ? 'التتبع على الخريطة' : 'Track on map'}</Text>
              </View>
              <OrderTrackingMap
                branchLat={branchLat}
                branchLon={branchLon}
                deliveryLat={order.deliveryLat}
                deliveryLng={order.deliveryLng}
                driverLat={otoStatus?.driverLat}
                driverLon={otoStatus?.driverLon}
                branchName={order.branchName}
                accentColor={primaryColor}
              />
            </View>
          )}

          <Text className="font-bold text-slate-800 mb-2">{isArabic ? 'العناصر' : 'Items'}</Text>
          {order.items.map((item) => (
            <View key={item.uniqueId} className="flex-row items-center mb-3 p-3 bg-slate-50 rounded-xl">
              <Image source={{ uri: item.image }} className="w-12 h-12 rounded-lg bg-slate-200" />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-slate-800">{item.name}</Text>
                <View className="flex-row flex-wrap items-center">
                  <Text className="text-slate-500 text-sm">{item.quantity} × </Text>
                  <PriceWithSymbol amount={item.price} iconSize={14} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 14 }} />
                  <Text className="text-slate-500 text-sm"> = </Text>
                  <PriceWithSymbol amount={item.price * item.quantity} iconSize={14} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 14 }} />
                </View>
              </View>
              <PriceWithSymbol amount={item.price * item.quantity} iconSize={16} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700' }} />
            </View>
          ))}

          <View className="border-t border-slate-200 mt-4 pt-4 flex-row justify-between">
            <Text className="font-bold text-slate-800">{isArabic ? 'الإجمالي' : 'Total'}</Text>
            <PriceWithSymbol amount={order.total} iconSize={18} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700', fontSize: 18 }} />
          </View>

          {/* Report Issue (delivered orders, 24h window) */}
          {canReportIssue && !loadingComplaint && (
            <TouchableOpacity
              onPress={() => setShowComplaintModal(true)}
              className="mt-4 py-4 rounded-2xl items-center flex-row justify-center gap-2 border-2 border-red-200 bg-red-50"
            >
              <MessageSquare size={18} color="#EF4444" />
              <Text className="text-red-600 font-bold text-base">{isArabic ? 'الإبلاغ عن مشكلة' : 'Report Issue'}</Text>
            </TouchableOpacity>
          )}

          {/* Support contact */}
          {isDelivered && (
            <View className="mt-3 p-3 bg-slate-50 rounded-xl">
              <Text className="text-slate-500 text-xs text-center">
                {isArabic ? 'هل تحتاج إلى مساعدة؟ تواصل مع الدعم عبر واتساب أو اتصل بنا' : 'Need help? Contact support via WhatsApp or call us'}
              </Text>
            </View>
          )}

          {/* Re-order button */}
          {(order.status === 'Delivered' || order.status === 'Cancelled') && (
            <TouchableOpacity
              onPress={handleReorder}
              className="mt-4 py-4 rounded-2xl items-center flex-row justify-center gap-2"
              style={{ backgroundColor: primaryColor }}
            >
              <RefreshCw size={18} color="white" />
              <Text className="text-white font-bold text-base">{isArabic ? 'إعادة الطلب' : 'Re-order'}</Text>
            </TouchableOpacity>
          )}

          <View className="h-6" />
        </ScrollView>
      </View>

      {/* ── Complaint Modal ── */}
      <Modal visible={showComplaintModal} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-3xl p-6 max-h-[90%]">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-lg font-bold text-slate-800">{isArabic ? 'الإبلاغ عن مشكلة' : 'Report an Issue'}</Text>
              <TouchableOpacity onPress={() => setShowComplaintModal(false)}>
                <X size={24} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Issue type */}
              <Text className="font-bold text-slate-700 mb-2">{isArabic ? 'ما المشكلة التي حدثت؟' : 'What went wrong?'}</Text>
              <View className="flex-row flex-wrap gap-2 mb-4">
                {[
                  ...STORE_COMPLAINT_TYPES,
                  ...(order.orderType === 'delivery' ? FLEET_COMPLAINT_TYPES : []),
                  ...OTHER_COMPLAINT_TYPES,
                ].map((ct) => (
                  <Pressable
                    key={ct.value}
                    onPress={() => setComplaintType(ct.value)}
                    className={`px-4 py-2 rounded-full border ${complaintType === ct.value ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'}`}
                  >
                    <Text className={complaintType === ct.value ? 'text-red-600 font-bold text-sm' : 'text-slate-600 text-sm'}>
                      {isArabic ? COMPLAINT_TYPE_ARABIC[ct.value as ComplaintTypeValue] : ct.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Description */}
              <Text className="font-bold text-slate-700 mb-2">{isArabic ? 'الوصف' : 'Description'}</Text>
              <TextInput
                value={complaintDescription}
                onChangeText={setComplaintDescription}
                placeholder={isArabic ? 'اكتب وصف المشكلة...' : 'Describe the issue...'}
                multiline
                numberOfLines={3}
                className="border border-slate-200 rounded-xl p-3 text-slate-700 mb-4"
                style={{ textAlignVertical: 'top', minHeight: 80 }}
              />

              {/* Photos */}
              <Text className="font-bold text-slate-700 mb-2">{isArabic ? 'الصور (اختياري، بحد أقصى 3)' : 'Photos (optional, max 3)'}</Text>
              <View className="flex-row gap-2 mb-4">
                {complaintPhotos.map((url, i) => (
                  <View key={i} className="relative">
                    <Image source={{ uri: url }} className="w-20 h-20 rounded-xl" />
                    <TouchableOpacity
                      onPress={() => setComplaintPhotos((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute -top-1 -right-1 bg-red-500 rounded-full w-5 h-5 items-center justify-center"
                    >
                      <X size={12} color="white" />
                    </TouchableOpacity>
                  </View>
                ))}
                {complaintPhotos.length < 3 && (
                  <TouchableOpacity
                    onPress={handlePickPhoto}
                    className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 items-center justify-center"
                  >
                    <Camera size={24} color="#94a3b8" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Affected items */}
              <Text className="font-bold text-slate-700 mb-2">{isArabic ? 'العناصر المتأثرة' : 'Affected items'}</Text>
              {order?.items.map((item) => (
                <Pressable
                  key={item.uniqueId}
                  onPress={() => setSelectedItems((prev) => ({ ...prev, [item.uniqueId]: !prev[item.uniqueId] }))}
                  className={`flex-row items-center p-3 mb-2 rounded-xl border ${selectedItems[item.uniqueId] ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`}
                >
                  <View className={`w-5 h-5 rounded border mr-3 items-center justify-center ${selectedItems[item.uniqueId] ? 'bg-red-500 border-red-500' : 'border-slate-300'}`}>
                    {selectedItems[item.uniqueId] && <Text className="text-white text-xs font-bold">✓</Text>}
                  </View>
                  <Text className="flex-1 text-slate-700">{item.name}</Text>
                  <View className="flex-row items-center"><PriceWithSymbol amount={item.price} iconSize={14} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 14 }} /><Text className="text-slate-500 text-sm"> × {item.quantity}</Text></View>
                </Pressable>
              ))}

              {/* Submit */}
              <TouchableOpacity
                onPress={handleSubmitComplaint}
                disabled={submittingComplaint}
                className="mt-4 py-4 rounded-2xl items-center"
                style={{ backgroundColor: '#EF4444' }}
              >
                {submittingComplaint ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-bold text-base">{isArabic ? 'إرسال الشكوى' : 'Submit Complaint'}</Text>
                )}
              </TouchableOpacity>
              <View className="h-6" />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
