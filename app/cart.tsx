import { useRouter } from 'expo-router';
import { ArrowLeft, Bike, ChevronRight, Minus, Pencil, Plus, Store, Trash2 } from 'lucide-react-native';
import React from 'react';
import { Alert } from 'react-native';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useOperations } from '../src/context/OperationsContext';

export default function CartScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { isClosed, isBusy } = useOperations();
  const isArabic = i18n.language === 'ar';
  const {
    cartItems,
    updateQuantity,
    removeFromCart,
    totalPrice,
    orderType,
    selectedBranch,
    deliveryAddress,
  } = useCart();

  const handleEditItem = (item: (typeof cartItems)[0]) => {
    router.push({ pathname: '/product', params: { id: item.id, uniqueId: item.uniqueId } });
  };

  const deliveryFee = orderType === 'delivery' ? 15 : 0;
  const finalTotal = totalPrice + deliveryFee;

  const handleCheckout = () => {
    if (isClosed || isBusy) {
      Alert.alert(
        isArabic ? 'الطلب غير متاح' : 'Ordering Unavailable',
        isClosed
          ? (isArabic ? 'المتجر مغلق حالياً.' : 'Store is currently closed.')
          : (isArabic ? 'المتجر مشغول حالياً ولا يستقبل طلبات جديدة.' : 'Store is currently busy and not accepting new orders.')
      );
      return;
    }
    if (orderType === 'delivery' && !deliveryAddress?.address) {
      router.push('/order-type');
      return;
    }
    if (!selectedBranch?.id) {
      router.push('/order-type');
      return;
    }
    router.push('/checkout');
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      {/* --- HEADER --- */}
      <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
        <TouchableOpacity
          onPress={() => router.back()}
          className="bg-slate-100 p-2 rounded-full"
        >
          <ArrowLeft size={22} color="#334155" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-slate-900">{isArabic ? 'سلتي' : 'My Basket'}</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        className="flex-1 px-5 pt-6"
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        {/* --- ORDER TYPE STATUS --- */}
          <View className="flex-row items-center p-4 bg-slate-50 rounded-3xl mb-8 border border-slate-100">
            <View style={orderType === 'delivery' ? { backgroundColor: `${primaryColor}20` } : undefined} className={orderType === 'delivery' ? 'p-3 rounded-2xl' : 'bg-orange-100 p-3 rounded-2xl'}>
              {orderType === 'delivery' ? (
                <Bike size={24} color={primaryColor} />
              ) : (
                <Store size={24} color="#F59E0B" />
              )}
            </View>
            <View className="ml-4 flex-1">
              <Text className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                {orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')}
              </Text>
              <Text className="text-slate-800 font-bold text-base" numberOfLines={2}>
                {orderType === 'delivery'
                  ? deliveryAddress?.address || (isArabic ? 'أضف عنوان التوصيل' : 'Add delivery address')
                  : selectedBranch?.name || (isArabic ? 'اختر الفرع' : 'Select branch')}
              </Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/order-type')}>
              <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? 'تغيير' : 'Change'}</Text>
            </TouchableOpacity>
          </View>

          <Text className="text-lg font-bold text-slate-900 mb-4">{isArabic ? 'ملخص الطلب' : 'Order Summary'}</Text>

          {/* --- CART ITEMS --- */}
          {cartItems.length === 0 ? (
            <View className="items-center py-20">
              <Text className="text-slate-400 font-medium text-lg">{isArabic ? 'سلتك فارغة' : 'Your basket is empty'}</Text>
              <TouchableOpacity
                onPress={() => router.back()}
                className="mt-4"
              >
                <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? 'اذهب لإضافة بعض القهوة!' : 'Go add some coffee!'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            cartItems.map((item) => (
              <View
                key={item.uniqueId}
                className="flex-row items-center mb-6 bg-white rounded-3xl p-3 border border-slate-100 shadow-sm"
              >
                <Image
                  source={{ uri: item.image }}
                  className="w-20 h-20 rounded-2xl bg-slate-100"
                />

                <View className="flex-1 ml-4">
                  <Text className="text-base font-bold text-slate-800" numberOfLines={1}>
                    {item.name}
                  </Text>

                  {!!item.customizations && (
                    <Text className="text-slate-400 text-xs mt-0.5" numberOfLines={1}>
                      {Object.values(item.customizations)
                        .map((opt: any) => opt.name)
                        .join(' • ')}
                    </Text>
                  )}

                  <PriceWithSymbol amount={item.price * item.quantity} iconSize={16} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700' }} className="mt-1" />
                </View>

                <View className="items-center">
                  <TouchableOpacity
                    onPress={() => handleEditItem(item)}
                    className="mb-2 flex-row items-center p-2"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Pencil size={18} color={primaryColor} />
                    <Text className="font-bold text-sm ml-1.5" style={{ color: primaryColor }}>{isArabic ? 'تعديل' : 'Edit'}</Text>
                  </TouchableOpacity>
                  <View className="flex-row items-center bg-slate-100 rounded-2xl p-2">
                    <TouchableOpacity
                      onPress={() => updateQuantity(item.uniqueId, -1)}
                      className="p-2.5 bg-white rounded-xl shadow-sm"
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Minus size={20} color="#64748b" />
                    </TouchableOpacity>

                    <Text className="mx-4 font-bold text-slate-800 text-base">
                      {item.quantity}
                    </Text>

                    <TouchableOpacity
                      onPress={() => updateQuantity(item.uniqueId, 1)}
                      className="p-2.5 bg-white rounded-xl shadow-sm"
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Plus size={20} color={primaryColor} />
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    onPress={() => removeFromCart(item)}
                    className="mt-2 p-2"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Trash2 size={22} color="#f87171" />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}

          {!!cartItems.length && (
            <View className="mt-4 p-6 bg-slate-50 rounded-[32px] border border-slate-100">
              <View className="flex-row justify-between mb-3">
                <Text className="text-slate-500 font-medium">{isArabic ? 'المجموع الفرعي' : 'Subtotal'}</Text>
                <PriceWithSymbol amount={totalPrice} iconSize={15} iconColor="#1e293b" textStyle={{ color: '#1e293b', fontWeight: '700' }} />
              </View>
              <View className="flex-row justify-between mb-3">
                <Text className="text-slate-500 font-medium">{isArabic ? 'رسوم الخدمة' : 'Service Fee'}</Text>
                {deliveryFee > 0 ? (
                  <PriceWithSymbol amount={deliveryFee} iconSize={15} iconColor="#1e293b" textStyle={{ color: '#1e293b', fontWeight: '700' }} />
                ) : (
                  <Text className="text-slate-800 font-bold">{isArabic ? 'مجاني' : 'Free'}</Text>
                )}
              </View>

              <View className="h-[1px] bg-slate-200 my-4" />

              <View className="flex-row justify-between">
                <Text className="text-xl font-bold text-slate-900">{isArabic ? 'الإجمالي' : 'Total'}</Text>
                <View>
                  <PriceWithSymbol amount={finalTotal} iconSize={18} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700', fontSize: 20 }} />
                  <Text className="text-[10px] text-slate-400 text-right">{isArabic ? 'شامل الضريبة' : 'VAT Included'}</Text>
                </View>
              </View>
            </View>
          )}
      </ScrollView>

      {!!cartItems.length && (
        <View className="p-6 pt-4 pb-8 bg-white border-t border-slate-100">
              {(isClosed || isBusy) && (
            <Text className="text-center text-red-500 font-bold mb-2">
              {isClosed ? (isArabic ? 'المتجر مغلق - لا يمكن إتمام الطلب' : 'Store is closed - checkout unavailable') : (isArabic ? 'المتجر مشغول - إتمام الطلب متوقف مؤقتاً' : 'Store is busy - checkout temporarily unavailable')}
            </Text>
          )}
          <TouchableOpacity
            style={{ backgroundColor: (isClosed || isBusy) ? '#94a3b8' : primaryColor }}
            className="p-5 rounded-[28px] flex-row items-center shadow-xl"
            activeOpacity={0.9}
            onPress={handleCheckout}
          >
            <View className="bg-white/20 px-3 py-1.5 rounded-xl mr-3">
              <Text className="text-white font-bold">{cartItems.length}</Text>
            </View>
            <Text className="text-white font-bold text-xl">{isArabic ? 'المتابعة للدفع' : 'Proceed to Checkout'}</Text>
            <View className="ml-4 mr-3">
              <PriceWithSymbol amount={finalTotal} iconSize={18} iconColor="#fff" textStyle={{ color: '#fff', fontWeight: '700', fontSize: 18 }} />
            </View>
            <ChevronRight size={24} color="white" />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}