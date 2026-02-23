import { useRouter } from 'expo-router';
import { ArrowLeft, Bike, ChevronRight, Minus, Pencil, Plus, Store, Trash2 } from 'lucide-react-native';
import React from 'react';
import { Image, SafeAreaView, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useOperations } from '../src/context/OperationsContext';

export default function CartScreen() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { isClosed } = useOperations();
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
    if (isClosed) return;
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
        <Text className="text-xl font-bold text-slate-900">My Basket</Text>
        <View className="w-10" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} className="flex-1 px-5 pt-6">
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
              {orderType === 'delivery' ? 'Delivering to' : 'Picking up from'}
            </Text>
            <Text className="text-slate-800 font-bold text-base" numberOfLines={2}>
              {orderType === 'delivery'
                ? deliveryAddress?.address || 'Add delivery address'
                : selectedBranch?.name || 'Select branch'}
            </Text>
          </View>
          <TouchableOpacity onPress={() => router.push('/order-type')}>
            <Text className="font-bold" style={{ color: primaryColor }}>Change</Text>
          </TouchableOpacity>
        </View>

        <Text className="text-lg font-bold text-slate-900 mb-4">Order Summary</Text>

        {/* --- CART ITEMS --- */}
        {cartItems.length === 0 ? (
          <View className="items-center py-20">
            <Text className="text-slate-400 font-medium text-lg">Your basket is empty</Text>
            <TouchableOpacity 
              onPress={() => router.back()}
              className="mt-4"
            >
              <Text className="font-bold" style={{ color: primaryColor }}>Go add some coffee!</Text>
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
                
                {/* Render customizations safely */}
                {!!item.customizations && (
                  <Text className="text-slate-400 text-xs mt-0.5" numberOfLines={1}>
                    {Object.values(item.customizations)
                      .map((opt: any) => opt.name)
                      .join(' • ')}
                  </Text>
                )}
                
                <Text className="font-bold mt-1" style={{ color: primaryColor }}>
                  {item.price * item.quantity} SAR
                </Text>
              </View>
              
              {/* Edit & Quantity Controls */}
              <View className="items-center">
                <TouchableOpacity
                  onPress={() => handleEditItem(item)}
                  className="mb-2 flex-row items-center p-2"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Pencil size={18} color={primaryColor} />
                  <Text className="font-bold text-sm ml-1.5" style={{ color: primaryColor }}>Edit</Text>
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

        {/* --- BILLING DETAILS --- */}
        {!!cartItems.length && (
          <View className="mt-4 p-6 bg-slate-50 rounded-[32px] mb-32 border border-slate-100">
            <View className="flex-row justify-between mb-3">
              <Text className="text-slate-500 font-medium">Subtotal</Text>
              <Text className="text-slate-800 font-bold">{totalPrice} SAR</Text>
            </View>
            <View className="flex-row justify-between mb-3">
              <Text className="text-slate-500 font-medium">Service Fee</Text>
              <Text className="text-slate-800 font-bold">
                {deliveryFee > 0 ? `${deliveryFee} SAR` : 'Free'}
              </Text>
            </View>
            
            <View className="h-[1px] bg-slate-200 my-4" />
            
            <View className="flex-row justify-between">
              <Text className="text-xl font-bold text-slate-900">Total</Text>
              <View>
                <Text className="text-xl font-bold text-right" style={{ color: primaryColor }}>
                  {finalTotal} SAR
                </Text>
                <Text className="text-[10px] text-slate-400 text-right">VAT Included</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* --- BOTTOM CHECKOUT BUTTON --- */}
      {!!cartItems.length && (
        <View className="absolute bottom-0 left-0 right-0 bg-white p-6 pb-10 border-t border-slate-100">
          {isClosed && (
            <Text className="text-center text-red-500 font-bold mb-2">Store is closed — checkout unavailable</Text>
          )}
          <TouchableOpacity
            style={{ backgroundColor: isClosed ? '#94a3b8' : primaryColor }}
            className="p-5 rounded-[28px] flex-row justify-between items-center shadow-xl"
            activeOpacity={isClosed ? 1 : 0.9}
            onPress={handleCheckout}
            disabled={isClosed}
          >
            <View className="flex-row items-center">
              <View className="bg-white/20 p-2 rounded-xl mr-3">
                <Text className="text-white font-bold">{cartItems.length}</Text>
              </View>
              <Text className="text-white font-bold text-xl">Proceed to Checkout</Text>
            </View>
            <ChevronRight size={24} color="white" />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}