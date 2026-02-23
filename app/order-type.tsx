import { ArrowLeft, Bike, MapPin, Pencil, Plus, Store, Trash2 } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Dimensions, KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMenuContext } from '../src/context/MenuContext';
import { useOperations } from '../src/context/OperationsContext';
import { useSavedAddresses } from '../src/context/SavedAddressesContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

const SCREEN_HEIGHT = Dimensions.get('window').height;

export default function OrderTypeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { primaryColor } = useMerchantBranding();
  const { orderType, setOrderType, selectedBranch, setSelectedBranch, setDeliveryAddress } = useCart();
  const { branches } = useMenuContext();
  const { isClosed, isPickupOnly } = useOperations();
  const { addresses: savedAddresses, setDefault, updateAddress, removeAddress } = useSavedAddresses();
  const [step, setStep] = useState<'choice' | 'branch' | 'map'>('choice');

  const handleSelectBranch = (branch: (typeof branches)[0]) => {
    setSelectedBranch(branch);
    if (orderType === 'delivery') {
      setStep('map');
    } else {
      router.back();
    }
  };

  /** Parse distance string like "1.5 km" to number for sorting. */
  const parseDistance = (d: string | undefined): number => {
    if (!d) return Infinity;
    const m = d.match(/([\d.]+)\s*km?/i);
    return m ? parseFloat(m[1]) : Infinity;
  };

  const sortedBranches = useMemo(
    () => [...branches].sort((a, b) => parseDistance(a.distance) - parseDistance(b.distance)),
    [branches],
  );

  const handleDelivery = () => {
    setOrderType('delivery');
    const closest = sortedBranches[0];
    if (closest) setSelectedBranch(closest);
    setStep('map');
  };

  const modalHeight = SCREEN_HEIGHT * 0.65;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'white', borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden', paddingBottom: insets.bottom }}
      >
        <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
        <TouchableOpacity
          onPress={() => {
            if (step === 'choice') router.back();
            else if (step === 'map' && orderType === 'delivery') setStep('branch');
            else setStep('choice');
          }}
          className="bg-slate-100 p-2 rounded-full"
        >
          <ArrowLeft size={22} color="#334155" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-slate-800">
          {step === 'choice' ? 'Order Type' : step === 'branch' ? 'Select Branch' : 'Delivery Address'}
        </Text>
        <View className="w-10" />
      </View>
      {step === 'map' ? (
        <View className="flex-1" style={{ paddingHorizontal: 20, paddingTop: 16 }}>
          <Text className="text-2xl font-bold text-slate-900 mb-4">Delivery Address</Text>
          <ScrollView
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
            keyboardShouldPersistTaps="handled"
          >
            {savedAddresses.length > 0 ? (
              <View>
                <Text className="text-slate-600 font-bold text-sm mb-2">Saved locations</Text>
                {savedAddresses.map((addr) => {
                  const label = addr.label === 'Other' && addr.customLabel ? addr.customLabel : addr.label;
                  const selectAddress = () => {
                    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: addr.city });
                    router.back();
                  };
                  return (
                    <TouchableOpacity
                      key={addr.id}
                      onPress={selectAddress}
                      activeOpacity={0.8}
                      className="p-4 mb-2 rounded-2xl border bg-slate-50 border-slate-100"
                    >
                      <View className="flex-row items-center">
                        <View className="p-2 rounded-xl mr-3 bg-slate-200">
                          <MapPin size={18} color="#64748b" />
                        </View>
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <Text className="font-bold text-slate-800">{label}</Text>
                            {addr.isDefault && (
                              <View className="px-1.5 py-0.5 rounded" style={{ backgroundColor: primaryColor }}>
                                <Text className="text-white text-[10px] font-bold">Default</Text>
                              </View>
                            )}
                          </View>
                          <Text className="text-slate-500 text-sm" numberOfLines={1}>{addr.address}</Text>
                        </View>
                      </View>
                      <View className="flex-row items-center justify-between mt-3 pt-2 border-t border-slate-200">
                        {!addr.isDefault && (
                          <TouchableOpacity
                            onPress={() => setDefault(addr.id)}
                            style={{ backgroundColor: `${primaryColor}18` }}
                            className="px-3 py-2 rounded-lg"
                          >
                            <Text className="font-bold text-sm" style={{ color: primaryColor }}>Set as default</Text>
                          </TouchableOpacity>
                        )}
                        <View className="flex-row gap-3 ml-auto">
                          <TouchableOpacity
                            onPress={() => router.push(`/add-address-modal?from=delivery&edit=${addr.id}`)}
                            className="p-2.5"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Pencil size={20} color="#64748b" />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => removeAddress(addr.id)}
                            className="p-2.5"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Trash2 size={20} color="#ef4444" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              <View className="py-4" />
            )}
          </ScrollView>
          <TouchableOpacity
            onPress={() => router.push('/add-address-modal?from=delivery')}
            className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl"
          >
            <Plus size={20} color={primaryColor} />
            <Text className="font-bold ml-2" style={{ color: primaryColor }}>Add new location</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 200 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 'choice' && (
          <View>
            <Text className="text-2xl font-bold text-slate-900 mb-6">How'll you have it?</Text>
            {isClosed && (
              <View className="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-200">
                <Text className="font-bold text-amber-800">Store is currently closed</Text>
                <Text className="text-amber-700 text-sm mt-1">You can still browse the menu. Orders will be available when we reopen.</Text>
              </View>
            )}
            {!isPickupOnly && (
              <TouchableOpacity
                onPress={handleDelivery}
                disabled={isClosed}
                className={`flex-row items-center p-5 rounded-[28px] mb-4 border border-slate-100 shadow-sm ${isClosed ? 'bg-slate-100 opacity-60' : 'bg-slate-50'}`}
              >
                <View className="p-4 rounded-2xl" style={{ backgroundColor: `${primaryColor}20` }}><Bike size={28} color={primaryColor} /></View>
                <View className="ml-4 flex-1">
                  <Text className="text-lg font-bold text-slate-800">Delivery</Text>
                  <Text className="text-slate-500 text-xs">Direct to your doorstep</Text>
                </View>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => { setOrderType('pickup'); setStep('branch'); }}
              disabled={isClosed}
              className={`flex-row items-center p-5 rounded-[28px] bg-slate-50 border border-slate-100 shadow-sm ${isClosed ? 'opacity-60' : ''}`}
            >
              <View className="bg-orange-100 p-4 rounded-2xl"><Store size={28} color="#F59E0B" /></View>
              <View className="ml-4 flex-1">
                <Text className="text-lg font-bold text-slate-800">In-Store Pickup</Text>
                <Text className="text-slate-500 text-xs">Skip the line & grab it fresh</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {step === 'branch' && (
          <View className="pb-8">
            <Text className="text-2xl font-bold mb-6">Select Branch</Text>
            {sortedBranches.map((b) => (
                <TouchableOpacity
                  key={b.id}
                  onPress={() => handleSelectBranch(b)}
                  style={selectedBranch?.id === b.id ? { backgroundColor: `${primaryColor}12`, borderColor: `${primaryColor}40` } : undefined}
                    className={`p-5 rounded-3xl mb-3 flex-row items-center border ${selectedBranch?.id === b.id ? '' : 'bg-slate-50 border-slate-100'}`}
                >
                  <View style={selectedBranch?.id === b.id ? { backgroundColor: primaryColor } : undefined} className={`p-3 rounded-xl mr-4 ${selectedBranch?.id === b.id ? '' : 'bg-slate-200'}`}>
                    <MapPin size={20} color={selectedBranch?.id === b.id ? 'white' : '#64748b'} />
                  </View>
                  <View className="flex-1">
                    <Text className="font-bold text-lg text-slate-800">{b.name}</Text>
                    <Text className="text-slate-500 text-xs">{b.address}</Text>
                  </View>
                  <Text className="font-bold text-xs" style={{ color: primaryColor }}>{b.distance}</Text>
                </TouchableOpacity>
              ))}
          </View>
        )}

      </ScrollView>
      )}
      </SwipeableBottomSheet>
    </KeyboardAvoidingView>
  );
}
