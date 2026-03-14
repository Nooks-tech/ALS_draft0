import { useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, Camera, Flag, Map, MapPin, MessageSquare, RefreshCw, Store, Truck, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useOrders } from '../src/context/OrdersContext';
import { useCart } from '../src/context/CartContext';
import { useAuth } from '../src/context/AuthContext';
import { getBranchOtoConfig } from '../src/config/branchOtoConfig';
import { OrderStatusStepper } from '../src/components/order/OrderStatusStepper';
import { OrderTrackingMap } from '../src/components/order/OrderTrackingMap';
import { otoApi, type OTOOrderStatusResponse } from '../src/api/oto';
import { customerCancelOrder, submitComplaint, getOrderComplaint, type ComplaintRow } from '../src/api/orders';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { supabase } from '../src/api/supabase';

const COMPLAINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPLAINT_TYPES = [
  { value: 'missing_item', label: 'Missing Item' },
  { value: 'wrong_item', label: 'Wrong Item' },
  { value: 'quality_issue', label: 'Quality Issue' },
  { value: 'other', label: 'Other' },
] as const;

export default function OrderDetailModal() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const { orders } = useOrders();
  const { setCartFromOrder } = useCart();
  const { user } = useAuth();
  const order = orders.find((o) => o.id === orderId);
  const { primaryColor } = useMerchantBranding();
  const [otoStatus, setOtoStatus] = useState<OTOOrderStatusResponse | null>(null);
  const driverPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cancelling, setCancelling] = useState(false);

  // Complaint state
  const [showComplaintModal, setShowComplaintModal] = useState(false);
  const [complaintType, setComplaintType] = useState<string>('missing_item');
  const [complaintDescription, setComplaintDescription] = useState('');
  const [complaintPhotos, setComplaintPhotos] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [submittingComplaint, setSubmittingComplaint] = useState(false);
  const [existingComplaint, setExistingComplaint] = useState<ComplaintRow | null>(null);
  const [loadingComplaint, setLoadingComplaint] = useState(false);

  // Load existing complaint for delivered orders
  useEffect(() => {
    if (!orderId || order?.status !== 'Delivered') return;
    setLoadingComplaint(true);
    getOrderComplaint(orderId).then((c) => {
      setExistingComplaint(c);
      setLoadingComplaint(false);
    }).catch(() => setLoadingComplaint(false));
  }, [orderId, order?.status]);

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

  const handleCancel = useCallback(async () => {
    if (!orderId) return;
    setCancelling(true);
    try {
      const result = await customerCancelOrder(orderId) as any;
      if (result.success) {
        if (result.refundStatus === 'refund_failed') {
          Alert.alert('Order Cancelled', `Order cancelled but refund failed.\n\nPayment ID: ${result.paymentId ?? 'none'}\nError: ${result.refundError ?? 'unknown'}`);
        } else {
          Alert.alert('Order Cancelled', 'Your order has been cancelled. A refund has been initiated.');
        }
      } else {
        Alert.alert('Cannot Cancel', result.error || 'Cancellation window expired.');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to cancel order');
    }
    setCancelling(false);
  }, [orderId]);

  const handlePickPhoto = async () => {
    if (complaintPhotos.length >= 3) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: 3 - complaintPhotos.length,
    });
    if (result.canceled) return;
    for (const asset of result.assets) {
      if (complaintPhotos.length >= 3) break;
      if (!supabase) continue;
      const ext = asset.uri.split('.').pop() || 'jpg';
      const fileName = `${orderId}/${Date.now()}.${ext}`;
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const { data, error } = await supabase.storage
        .from('complaint-photos')
        .upload(fileName, blob, { contentType: `image/${ext}` });
      if (!error && data?.path) {
        const { data: urlData } = supabase.storage.from('complaint-photos').getPublicUrl(data.path);
        if (urlData?.publicUrl) {
          setComplaintPhotos((prev) => [...prev, urlData.publicUrl]);
        }
      }
    }
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
        Alert.alert('Complaint Submitted', 'The merchant will review your complaint shortly.');
      } else {
        Alert.alert('Error', result.error || 'Failed to submit complaint');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to submit complaint');
    }
    setSubmittingComplaint(false);
  };

  if (!order) {
    return (
      <View className="flex-1 justify-center items-center bg-black/60">
        <View className="bg-white rounded-2xl p-6 max-w-sm">
          <Text className="text-slate-600 text-center">Order not found</Text>
          <TouchableOpacity onPress={() => router.back()} className="mt-4 py-3 rounded-xl" style={{ backgroundColor: primaryColor }}>
            <Text className="text-white font-bold text-center">Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const branchOto = getBranchOtoConfig(order.branchId ?? '', order.branchName);
  const branchLat = branchOto?.lat;
  const branchLon = branchOto?.lon;
  const isOutForDelivery = order.status === 'Out for delivery';
  const showDriverMap = isOutForDelivery && order.orderType === 'delivery' && branchLat != null && branchLon != null;
  const canShowMap = branchLat != null && branchLon != null;

  const showCancelButton = order.status === 'Preparing';

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
      return { label: 'Refunded', bg: 'bg-green-100', text: 'text-green-700' };
    if (order.refundStatus === 'refund_failed')
      return { label: 'Refund Failed', bg: 'bg-red-100', text: 'text-red-600' };
    if (order.refundStatus === 'pending_manual')
      return { label: 'Refund Pending', bg: 'bg-amber-100', text: 'text-amber-700' };
    return null;
  })();

  const complaintBadge = (() => {
    if (!existingComplaint) return null;
    if (existingComplaint.status === 'refunded')
      return { label: 'Complaint Approved', bg: 'bg-green-100', text: 'text-green-700' };
    if (existingComplaint.status === 'approved')
      return { label: 'Refund Processing', bg: 'bg-amber-100', text: 'text-amber-700' };
    if (existingComplaint.status === 'rejected')
      return { label: 'Complaint Rejected', bg: 'bg-red-100', text: 'text-red-600' };
    if (existingComplaint.status === 'pending')
      return { label: 'Complaint Pending', bg: 'bg-orange-100', text: 'text-orange-600' };
    return null;
  })();

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Order #{order.id.replace('order-', '')}</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-4" showsVerticalScrollIndicator={false}>
          {/* Status + refund badges */}
          <View className="mb-4">
            <View className="flex-row flex-wrap gap-2">
              <View className={`self-start px-3 py-1 rounded-full ${badge.bg}`}>
                <Text className={`text-xs font-bold ${badge.text}`}>{order.status}</Text>
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

          {showCancelButton && (
            <TouchableOpacity
              onPress={handleCancel}
              disabled={cancelling}
              className="mb-4 py-3 rounded-xl items-center"
              style={{ backgroundColor: '#EF4444' }}
            >
              {cancelling ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-bold">Cancel Order</Text>
              )}
            </TouchableOpacity>
          )}

          {/* Cancellation reason */}
          {order.status === 'Cancelled' && order.cancellationReason && (
            <View className="mb-4 p-4 bg-red-50 rounded-xl flex-row items-start">
              <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-red-700 text-sm">
                  {order.cancelledBy === 'merchant' ? 'Cancelled by store' : order.cancelledBy === 'system' ? 'Cancelled by system' : 'You cancelled this order'}
                </Text>
                <Text className="text-red-600 text-sm mt-1">{order.cancellationReason}</Text>
                {(order.refundStatus === 'refunded' || order.refundStatus === 'voided') && (
                  <Text className="text-green-600 text-xs mt-1 font-medium">
                    Refund of {order.refundAmount ?? order.total} SAR processed
                    {order.refundMethod === 'void' ? ' (voided — no fee)' : ''}
                  </Text>
                )}
                {order.refundStatus === 'pending_manual' && (
                  <Text className="text-amber-600 text-xs mt-1 font-medium">Refund being processed</Text>
                )}
                {order.refundStatus === 'refund_failed' && (
                  <Text className="text-red-600 text-xs mt-1 font-medium">Refund failed — please contact support</Text>
                )}
              </View>
            </View>
          )}

          {/* OTO dispatch failure */}
          {order.orderType === 'delivery' && order.otoDispatchStatus === 'failed' && (
            <View className="mb-4 p-4 bg-amber-50 rounded-xl flex-row items-start">
              <AlertTriangle size={18} color="#D97706" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-amber-700 text-sm">Delivery dispatch pending</Text>
                <Text className="text-amber-700 text-sm mt-1">
                  We could not send this order to the delivery provider yet. The store has your order and can retry dispatch.
                </Text>
                {!!order.otoDispatchError && (
                  <Text className="text-amber-800 text-xs mt-2">Details: {order.otoDispatchError}</Text>
                )}
              </View>
            </View>
          )}

          {/* Existing complaint info */}
          {existingComplaint && (
            <View className="mb-4 p-4 bg-slate-50 rounded-xl flex-row items-start">
              <Flag size={18} color="#6366F1" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-slate-700 text-sm">Complaint Filed</Text>
                <Text className="text-slate-600 text-sm mt-1 capitalize">{existingComplaint.complaint_type.replace('_', ' ')}</Text>
                {existingComplaint.status === 'refunded' && existingComplaint.approved_refund_amount && (
                  <Text className="text-green-600 text-xs mt-1 font-medium">
                    Refund of {existingComplaint.approved_refund_amount} SAR approved
                  </Text>
                )}
                {existingComplaint.status === 'rejected' && existingComplaint.merchant_notes && (
                  <Text className="text-red-600 text-xs mt-1">{existingComplaint.merchant_notes}</Text>
                )}
                {existingComplaint.status === 'pending' && (
                  <Text className="text-amber-600 text-xs mt-1 font-medium">Awaiting merchant review</Text>
                )}
              </View>
            </View>
          )}

          {order.status !== 'Cancelled' && order.status !== 'On Hold' && (
            <View className="mb-6">
              <Text className="font-bold text-slate-800 mb-3">Order status</Text>
              <OrderStatusStepper status={order.status as any} orderType={order.orderType} accentColor={primaryColor} />
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
                <Text className="font-bold text-slate-800">Live driver tracking</Text>
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
              <View className="flex-row flex-wrap gap-2 mt-2">
                <View className="flex-row items-center gap-1.5">
                  <View className="w-2 h-2 rounded-full bg-amber-500" />
                  <Text className="text-slate-500 text-xs">Branch</Text>
                </View>
                {(order.deliveryLat != null && order.deliveryLng != null) && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full" style={{ backgroundColor: primaryColor }} />
                    <Text className="text-slate-500 text-xs">Your location</Text>
                  </View>
                )}
                {otoStatus?.driverLat != null && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full bg-indigo-500" />
                    <Text className="text-slate-500 text-xs">Driver</Text>
                  </View>
                )}
              </View>
              {otoStatus?.estimatedDeliveryTime && (
                <Text className="text-slate-500 text-xs mt-2">ETA: {otoStatus.estimatedDeliveryTime}</Text>
              )}
            </View>
          )}

          {/* Static map for non-delivery-tracking orders */}
          {canShowMap && !showDriverMap && order.status !== 'Cancelled' && (
            <View className="mb-6">
              <View className="flex-row items-center gap-2 mb-3">
                <Map size={18} color={primaryColor} />
                <Text className="font-bold text-slate-800">Track on map</Text>
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

          <Text className="font-bold text-slate-800 mb-2">Items</Text>
          {order.items.map((item) => (
            <View key={item.uniqueId} className="flex-row items-center mb-3 p-3 bg-slate-50 rounded-xl">
              <Image source={{ uri: item.image }} className="w-12 h-12 rounded-lg bg-slate-200" />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-slate-800">{item.name}</Text>
                <Text className="text-slate-500 text-sm">
                  {item.quantity} × {item.price} SAR = {item.price * item.quantity} SAR
                </Text>
              </View>
              <Text className="font-bold" style={{ color: primaryColor }}>{item.price * item.quantity} SAR</Text>
            </View>
          ))}

          <View className="border-t border-slate-200 mt-4 pt-4 flex-row justify-between">
            <Text className="font-bold text-slate-800">Total</Text>
            <Text className="font-bold text-lg" style={{ color: primaryColor }}>{order.total} SAR</Text>
          </View>

          {/* Report Issue (delivered orders, 24h window) */}
          {canReportIssue && !loadingComplaint && (
            <TouchableOpacity
              onPress={() => setShowComplaintModal(true)}
              className="mt-4 py-4 rounded-2xl items-center flex-row justify-center gap-2 border-2 border-red-200 bg-red-50"
            >
              <MessageSquare size={18} color="#EF4444" />
              <Text className="text-red-600 font-bold text-base">Report Issue</Text>
            </TouchableOpacity>
          )}

          {/* Support contact */}
          {isDelivered && (
            <View className="mt-3 p-3 bg-slate-50 rounded-xl">
              <Text className="text-slate-500 text-xs text-center">
                Need help? Contact support via WhatsApp or call us
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
              <Text className="text-white font-bold text-base">Re-order</Text>
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
              <Text className="text-lg font-bold text-slate-800">Report an Issue</Text>
              <TouchableOpacity onPress={() => setShowComplaintModal(false)}>
                <X size={24} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Issue type */}
              <Text className="font-bold text-slate-700 mb-2">What went wrong?</Text>
              <View className="flex-row flex-wrap gap-2 mb-4">
                {COMPLAINT_TYPES.map((ct) => (
                  <Pressable
                    key={ct.value}
                    onPress={() => setComplaintType(ct.value)}
                    className={`px-4 py-2 rounded-full border ${complaintType === ct.value ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'}`}
                  >
                    <Text className={complaintType === ct.value ? 'text-red-600 font-bold text-sm' : 'text-slate-600 text-sm'}>
                      {ct.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Description */}
              <Text className="font-bold text-slate-700 mb-2">Description</Text>
              <TextInput
                value={complaintDescription}
                onChangeText={setComplaintDescription}
                placeholder="Describe the issue..."
                multiline
                numberOfLines={3}
                className="border border-slate-200 rounded-xl p-3 text-slate-700 mb-4"
                style={{ textAlignVertical: 'top', minHeight: 80 }}
              />

              {/* Photos */}
              <Text className="font-bold text-slate-700 mb-2">Photos (optional, max 3)</Text>
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
              <Text className="font-bold text-slate-700 mb-2">Affected items</Text>
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
                  <Text className="text-slate-500 text-sm">{item.price} SAR × {item.quantity}</Text>
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
                  <Text className="text-white font-bold text-base">Submit Complaint</Text>
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
